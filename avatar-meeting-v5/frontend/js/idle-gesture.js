/**
 * @fileoverview Body animation controller (idle noise + pose tracking).
 *
 * Two modes of operation:
 *  1. Noise mode (update): Perlin-noise driven idle gestures.
 *     Speech intensity from jawOpen makes gestures more pronounced.
 *  2. Pose mode (updateWithPose): MediaPipe Pose Landmarker drives
 *     upper-body bone rotations from actual camera-tracked body pose.
 *     Falls back to noise for bones with low landmark visibility.
 *
 * Design:
 *  - Captures each bone's base rotation (rest pose) at registration
 *  - Computes rest-pose world directions for pose tracking
 *  - Noise mode: finalRot = baseRot * noiseDelta * intensity
 *  - Pose mode:  finalRot = baseRot * poseLocalDelta (from landmarks)
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
  {
    pattern: /^(mixamorig:?)?Spine$/i,
    config: {
      seed: 11,
      freqX: 0.25, freqY: 0.20, freqZ: 0.30,
      ampX: 0.06, ampY: 0.08, ampZ: 0.05,
      speechBoost: 1.8,
    },
  },
  {
    pattern: /^(mixamorig:?)?Spine1$/i,
    config: {
      seed: 12,
      freqX: 0.28, freqY: 0.22, freqZ: 0.33,
      ampX: 0.08, ampY: 0.10, ampZ: 0.06,
      speechBoost: 1.8,
    },
  },
  {
    pattern: /^(mixamorig:?)?Spine2$/i,
    config: {
      seed: 13,
      freqX: 0.30, freqY: 0.25, freqZ: 0.35,
      ampX: 0.10, ampY: 0.12, ampZ: 0.08,
      speechBoost: 2.0,
    },
  },
  {
    pattern: /^(mixamorig:?)?LeftShoulder$/i,
    config: {
      seed: 21,
      freqX: 0.35, freqY: 0.30, freqZ: 0.40,
      ampX: 0.12, ampY: 0.08, ampZ: 0.10,
      speechBoost: 2.5,
    },
  },
  {
    pattern: /^(mixamorig:?)?RightShoulder$/i,
    config: {
      seed: 22,
      freqX: 0.33, freqY: 0.32, freqZ: 0.38,
      ampX: 0.12, ampY: 0.08, ampZ: 0.10,
      speechBoost: 2.5,
    },
  },
  {
    pattern: /^(mixamorig:?)?LeftArm$/i,
    config: {
      seed: 31,
      freqX: 0.40, freqY: 0.35, freqZ: 0.30,
      ampX: 0.18, ampY: 0.15, ampZ: 0.12,
      speechBoost: 3.0,
    },
  },
  {
    pattern: /^(mixamorig:?)?RightArm$/i,
    config: {
      seed: 32,
      freqX: 0.38, freqY: 0.37, freqZ: 0.32,
      ampX: 0.18, ampY: 0.15, ampZ: 0.12,
      speechBoost: 3.0,
    },
  },
  {
    pattern: /^(mixamorig:?)?LeftForeArm$/i,
    config: {
      seed: 41,
      freqX: 0.45, freqY: 0.40, freqZ: 0.35,
      ampX: 0.12, ampY: 0.10, ampZ: 0.08,
      speechBoost: 2.5,
    },
  },
  {
    pattern: /^(mixamorig:?)?RightForeArm$/i,
    config: {
      seed: 42,
      freqX: 0.43, freqY: 0.42, freqZ: 0.37,
      ampX: 0.12, ampY: 0.10, ampZ: 0.08,
      speechBoost: 2.5,
    },
  },
];

// ============================================================================
// MediaPipe Pose Landmark indices
// ============================================================================
const LM_LEFT_SHOULDER  = 11;
const LM_RIGHT_SHOULDER = 12;
const LM_LEFT_ELBOW     = 13;
const LM_RIGHT_ELBOW    = 14;
const LM_LEFT_WRIST     = 15;
const LM_RIGHT_WRIST    = 16;
const LM_LEFT_HIP       = 23;
const LM_RIGHT_HIP      = 24;

// Minimum visibility to trust a landmark
const MIN_VISIBILITY = 0.5;

// ============================================================================
// IdleGestureAnimator
// ============================================================================
export class IdleGestureAnimator {
  constructor() {
    /** @private */
    this._targets = [];
    /** @private */
    this._time = 0;

    this.enabled = true;
    /** @type {number} Global intensity multiplier (0..2) */
    this.intensity = 1.0;

    /** @private Smoothed speech intensity (from jawOpen) */
    this._speechEnv = 0;

    /** @private Reusable temp objects */
    this._tmpQuat = new THREE.Quaternion();
    this._tmpEuler = new THREE.Euler();
    this._deltaQuat = new THREE.Quaternion();
  }

  /**
   * Scan the avatar's skeleton and register matching bones.
   * Also computes rest-pose world directions for pose tracking.
   * @param {THREE.Object3D} avatarRoot
   */
  registerAvatar(avatarRoot) {
    this._targets = [];
    if (!avatarRoot) return;

    // Ensure world matrices are up to date for rest-pose direction computation
    avatarRoot.updateMatrixWorld(true);

    avatarRoot.traverse((obj) => {
      if (!obj.isBone && obj.type !== 'Bone') return;

      for (const rule of BONE_RULES) {
        if (rule.pattern.test(obj.name)) {
          // Compute rest-pose world direction (bone → child)
          let restWorldDir = null;
          const childBone = obj.children.find(c => c.isBone || c.type === 'Bone');
          if (childBone) {
            const boneWorldPos = new THREE.Vector3();
            const childWorldPos = new THREE.Vector3();
            obj.getWorldPosition(boneWorldPos);
            childBone.getWorldPosition(childWorldPos);
            restWorldDir = childWorldPos.sub(boneWorldPos).normalize();
          }

          // Store parent's rest world quaternion for local-space conversion
          let parentRestWorldQuat = null;
          if (obj.parent) {
            parentRestWorldQuat = new THREE.Quaternion();
            obj.parent.getWorldQuaternion(parentRestWorldQuat);
          }

          // Canonical bone name (strip mixamorig prefix)
          const canonName = obj.name.replace(/^(mixamorig:?)?/i, '');

          this._targets.push({
            bone: obj,
            canonName,
            baseQuat: obj.quaternion.clone(),
            noise: new Noise1D(rule.config.seed),
            config: rule.config,
            restWorldDir,
            parentRestWorldQuat,
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

  /** Clear registration (call before loading a new avatar). */
  clear() {
    for (const t of this._targets) {
      t.bone.quaternion.copy(t.baseQuat);
    }
    this._targets = [];
  }

  // ==========================================================================
  // Mode 1: Noise-driven idle animation (no camera body tracking)
  // ==========================================================================

  /**
   * Noise-driven update. Call when no pose data is available.
   * @param {number} dt - Elapsed ms since last frame
   * @param {Object<string, number>} blendShapes
   */
  update(dt, blendShapes) {
    if (!this.enabled || this._targets.length === 0) {
      for (const t of this._targets) {
        t.bone.quaternion.slerp(t.baseQuat, 0.2);
      }
      return;
    }

    this._time += dt / 1000;
    this._updateSpeechEnvelope(blendShapes);

    for (const t of this._targets) {
      this._applyNoise(t);
    }
  }

  // ==========================================================================
  // Mode 2: Pose-driven animation (camera body tracking)
  // ==========================================================================

  /**
   * Pose-driven update. Uses MediaPipe worldLandmarks to drive bone rotations.
   * Falls back to noise for bones with insufficient landmark visibility.
   * @param {number} dt - Elapsed ms since last frame
   * @param {Object<string, number>} blendShapes
   * @param {Array} worldLandmarks - MediaPipe 33 world landmarks
   * @param {boolean} mirrored - Whether to mirror (selfie mode)
   */
  updateWithPose(dt, blendShapes, worldLandmarks, mirrored) {
    if (!this.enabled || this._targets.length === 0) {
      for (const t of this._targets) {
        t.bone.quaternion.slerp(t.baseQuat, 0.2);
      }
      return;
    }

    this._time += dt / 1000;
    this._updateSpeechEnvelope(blendShapes);

    // Extract and convert landmark positions
    const pos = this._extractPosePositions(worldLandmarks, mirrored);
    if (!pos) {
      // Extraction failed — fall back to full noise
      for (const t of this._targets) this._applyNoise(t);
      return;
    }

    // Compute tracked body directions
    const dirs = this._computeTrackedDirections(pos);

    // Apply to each registered bone
    for (const t of this._targets) {
      const name = t.canonName;
      let applied = false;

      // Spine bones — Euler angle approach (lean from torso vector)
      if (/^Spine[12]?$/.test(name) && dirs.spineDir) {
        const weight = name === 'Spine' ? 0.25 : name === 'Spine1' ? 0.30 : 0.45;
        this._applyTrackedSpine(t, dirs.spineDir, weight);
        applied = true;
      }

      // Arm bones — direction vector approach
      if (name === 'LeftArm' && dirs.lArmDir) {
        this._applyTrackedLimb(t, dirs.lArmDir);
        applied = true;
      }
      if (name === 'RightArm' && dirs.rArmDir) {
        this._applyTrackedLimb(t, dirs.rArmDir);
        applied = true;
      }
      if (name === 'LeftForeArm' && dirs.lForearmDir) {
        this._applyTrackedLimb(t, dirs.lForearmDir);
        applied = true;
      }
      if (name === 'RightForeArm' && dirs.rForearmDir) {
        this._applyTrackedLimb(t, dirs.rForearmDir);
        applied = true;
      }

      // Shoulders and fallback — use noise
      if (!applied) {
        this._applyNoise(t);
      }
    }
  }

  // ==========================================================================
  // Pose tracking helpers
  // ==========================================================================

  /**
   * Extract relevant landmark positions, converting MediaPipe coords to Three.js.
   * @private
   */
  _extractPosePositions(worldLandmarks, mirrored) {
    if (!worldLandmarks || worldLandmarks.length < 25) return null;

    // Landmark index mapping (avatar left/right, accounting for mirror)
    const li  = mirrored ? LM_RIGHT_SHOULDER : LM_LEFT_SHOULDER;
    const ri  = mirrored ? LM_LEFT_SHOULDER  : LM_RIGHT_SHOULDER;
    const lei = mirrored ? LM_RIGHT_ELBOW    : LM_LEFT_ELBOW;
    const rei = mirrored ? LM_LEFT_ELBOW     : LM_RIGHT_ELBOW;
    const lwi = mirrored ? LM_RIGHT_WRIST    : LM_LEFT_WRIST;
    const rwi = mirrored ? LM_LEFT_WRIST     : LM_RIGHT_WRIST;
    const lhi = mirrored ? LM_RIGHT_HIP      : LM_LEFT_HIP;
    const rhi = mirrored ? LM_LEFT_HIP       : LM_RIGHT_HIP;

    // Convert: MediaPipe (x=image-right, y=down, z=toward-camera)
    //       → Three.js  (x=right, y=up, z=toward-viewer)
    const xSign = mirrored ? 1 : -1;
    const toVec3 = (lm) => new THREE.Vector3(xSign * lm.x, -lm.y, -lm.z);

    return {
      lShoulder: toVec3(worldLandmarks[li]),
      rShoulder: toVec3(worldLandmarks[ri]),
      lElbow:    toVec3(worldLandmarks[lei]),
      rElbow:    toVec3(worldLandmarks[rei]),
      lWrist:    toVec3(worldLandmarks[lwi]),
      rWrist:    toVec3(worldLandmarks[rwi]),
      lHip:      toVec3(worldLandmarks[lhi]),
      rHip:      toVec3(worldLandmarks[rhi]),
      // Visibility scores for confidence check
      lArmVis:   Math.min(worldLandmarks[li].visibility ?? 1, worldLandmarks[lei].visibility ?? 1),
      rArmVis:   Math.min(worldLandmarks[ri].visibility ?? 1, worldLandmarks[rei].visibility ?? 1),
      lForeVis:  Math.min(worldLandmarks[lei].visibility ?? 1, worldLandmarks[lwi].visibility ?? 1),
      rForeVis:  Math.min(worldLandmarks[rei].visibility ?? 1, worldLandmarks[rwi].visibility ?? 1),
    };
  }

  /**
   * Compute tracked body-segment directions from extracted positions.
   * @private
   */
  _computeTrackedDirections(pos) {
    const midShoulder = pos.lShoulder.clone().add(pos.rShoulder).multiplyScalar(0.5);
    const midHip = pos.lHip.clone().add(pos.rHip).multiplyScalar(0.5);

    return {
      spineDir: midShoulder.clone().sub(midHip).normalize(),
      lArmDir:     pos.lArmVis  > MIN_VISIBILITY ? pos.lElbow.clone().sub(pos.lShoulder).normalize() : null,
      rArmDir:     pos.rArmVis  > MIN_VISIBILITY ? pos.rElbow.clone().sub(pos.rShoulder).normalize() : null,
      lForearmDir: pos.lForeVis > MIN_VISIBILITY ? pos.lWrist.clone().sub(pos.lElbow).normalize()    : null,
      rForearmDir: pos.rForeVis > MIN_VISIBILITY ? pos.rWrist.clone().sub(pos.rElbow).normalize()    : null,
    };
  }

  /**
   * Apply tracked spine lean to a spine bone.
   * Uses Euler pitch/roll decomposition from the torso direction vector.
   * @private
   */
  _applyTrackedSpine(target, spineDir, weight) {
    // Decompose torso lean into pitch (forward/back) and roll (left/right)
    const pitch = Math.atan2(-spineDir.z, spineDir.y) * weight;
    const roll  = Math.atan2(spineDir.x, spineDir.y) * weight;

    // Clamp to reasonable range (~20° max per bone)
    const maxAngle = 0.35;
    const clampedPitch = THREE.MathUtils.clamp(pitch, -maxAngle, maxAngle);
    const clampedRoll  = THREE.MathUtils.clamp(roll, -maxAngle, maxAngle);

    this._tmpEuler.set(clampedPitch, 0, clampedRoll, 'XYZ');
    this._deltaQuat.setFromEuler(this._tmpEuler);
    this._tmpQuat.copy(target.baseQuat).multiply(this._deltaQuat);
    target.bone.quaternion.slerp(this._tmpQuat, 0.25);
  }

  /**
   * Apply tracked limb direction to an arm/forearm bone.
   * Uses setFromUnitVectors to compute the rotation from rest to tracked direction,
   * then converts from world space to bone-local space.
   * @private
   */
  _applyTrackedLimb(target, trackedDir) {
    if (!target.restWorldDir) {
      this._applyNoise(target);
      return;
    }

    // World-space delta: rotation from rest direction to tracked direction
    const worldDelta = new THREE.Quaternion().setFromUnitVectors(target.restWorldDir, trackedDir);

    let newLocalQuat;
    if (target.parentRestWorldQuat) {
      // Convert world delta to bone-local space via conjugate transform:
      // localDelta = inv(parentWorldRest) * worldDelta * parentWorldRest
      const localDelta = target.parentRestWorldQuat.clone().invert()
        .multiply(worldDelta)
        .multiply(target.parentRestWorldQuat);
      // newLocal = localDelta * baseQuat
      newLocalQuat = localDelta.multiply(target.baseQuat);
    } else {
      // No parent info — apply world delta directly (approximate)
      newLocalQuat = worldDelta.multiply(target.baseQuat);
    }

    target.bone.quaternion.slerp(newLocalQuat, 0.25);
  }

  // ==========================================================================
  // Shared helpers
  // ==========================================================================

  /** @private */
  _updateSpeechEnvelope(blendShapes) {
    const jawOpen = blendShapes?.jawOpen || 0;
    const rawSpeech = Math.max(0, (jawOpen - 0.04) / 0.35);
    const targetSpeech = Math.min(1, rawSpeech);
    const coef = targetSpeech > this._speechEnv ? 0.25 : 0.04;
    this._speechEnv += (targetSpeech - this._speechEnv) * coef;
  }

  /**
   * Apply noise-driven rotation to a single bone (idle animation).
   * @private
   */
  _applyNoise(target) {
    const cfg = target.config;
    const idleAmp = 0.5;
    const speechAmp = this._speechEnv * cfg.speechBoost;
    const totalAmp = (idleAmp + speechAmp) * this.intensity;

    const nx = target.noise.fbm(this._time * cfg.freqX + 0, 3);
    const ny = target.noise.fbm(this._time * cfg.freqY + 100, 3);
    const nz = target.noise.fbm(this._time * cfg.freqZ + 200, 3);

    this._tmpEuler.set(
      nx * cfg.ampX * totalAmp,
      ny * cfg.ampY * totalAmp,
      nz * cfg.ampZ * totalAmp,
      'XYZ'
    );
    this._deltaQuat.setFromEuler(this._tmpEuler);
    this._tmpQuat.copy(target.baseQuat).multiply(this._deltaQuat);
    target.bone.quaternion.slerp(this._tmpQuat, 0.5);
  }
}
