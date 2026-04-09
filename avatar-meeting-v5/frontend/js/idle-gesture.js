/**
 * @fileoverview Body animation controller — v8 arm retargeting + idle noise.
 *
 * v8 changes:
 *   - Real arm retargeting using inferPrimaryAxis() + computeRetargetedQuat()
 *   - Spine lean tracked directly from pose (unchanged from v7)
 *   - Idle noise amplitudes reduced to v7 spec
 *   - Shoulders use noise only (retargeting shoulders is unreliable)
 */

import * as THREE from 'three';

// ============================================================================
// Simple 1D Perlin-like noise
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
// Bone retargeting helpers
// ============================================================================

/** Reusable temp objects (avoid GC) */
const _tmpVec3a = new THREE.Vector3();
const _tmpVec3b = new THREE.Vector3();
const _tmpQuatA = new THREE.Quaternion();
const _tmpQuatB = new THREE.Quaternion();

/**
 * Infer a bone's "primary axis" — the direction it points to its first child.
 * This is the ground truth for where the bone is pointing in its rest pose,
 * expressed in its own local coordinate system.
 *
 * @param {THREE.Bone} bone
 * @returns {THREE.Vector3|null} Normalized local direction, or null if no children
 */
function inferPrimaryAxis(bone) {
  if (!bone.children || bone.children.length === 0) return null;
  const childBone = bone.children.find((c) => c.isBone || c.type === 'Bone');
  if (!childBone) return null;
  const dir = childBone.position.clone();
  if (dir.lengthSq() < 1e-8) return null;
  return dir.normalize();
}

/**
 * Retarget a bone so that its primary axis points in `desiredWorldDir`.
 * Uses parent's world transform to convert the target into local space,
 * then builds a minimal rotation from restAxis to the target direction.
 *
 * @param {THREE.Bone} bone
 * @param {THREE.Vector3} primaryAxisLocal - Rest axis in the bone's OWN local space
 * @param {THREE.Vector3} desiredWorldDir - Target direction in world space (normalized)
 * @returns {THREE.Quaternion|null} The computed local quaternion
 */
function computeRetargetedQuat(bone, primaryAxisLocal, desiredWorldDir) {
  const parent = bone.parent;
  if (!parent) return null;
  parent.updateWorldMatrix(true, false);
  parent.getWorldQuaternion(_tmpQuatA);

  // Invert to get "parent-local" transform
  _tmpQuatB.copy(_tmpQuatA).invert();

  // Transform desiredWorldDir into parent-local space
  _tmpVec3a.copy(desiredWorldDir).applyQuaternion(_tmpQuatB).normalize();

  // Build the minimal rotation from primaryAxis (rest) to desired (parent-local)
  const result = new THREE.Quaternion().setFromUnitVectors(
    primaryAxisLocal,
    _tmpVec3a
  );

  return result;
}

/**
 * Clamp a quaternion's angular distance from a reference.
 * Prevents impossible poses by limiting max deviation from rest.
 * @param {THREE.Quaternion} q - Target quaternion (modified in place)
 * @param {THREE.Quaternion} ref - Reference (rest) quaternion
 * @param {number} maxAngleRad - Maximum allowed angle (radians)
 */
function clampQuatAngle(q, ref, maxAngleRad) {
  _tmpQuatA.copy(ref).invert().multiply(q);
  const angle = 2 * Math.acos(Math.min(1, Math.abs(_tmpQuatA.w)));
  if (angle > maxAngleRad) {
    const t = maxAngleRad / angle;
    _tmpQuatB.identity().slerp(_tmpQuatA, t);
    q.copy(ref).multiply(_tmpQuatB);
  }
}

// ============================================================================
// Bone config — noise parameters per bone (v7 spec amplitudes)
// ============================================================================
const BONE_RULES = [
  // Spine — subtle sway
  {
    pattern: /^(mixamorig:?)?Spine$/i,
    config: {
      seed: 11, group: 'spine',
      freqX: 0.25, freqY: 0.20, freqZ: 0.30,
      ampX: 0.020, ampY: 0.025, ampZ: 0.015,
      speechBoost: 1.8, poseBoost: 1.5,
    },
  },
  {
    pattern: /^(mixamorig:?)?Spine1$/i,
    config: {
      seed: 12, group: 'spine',
      freqX: 0.28, freqY: 0.22, freqZ: 0.33,
      ampX: 0.025, ampY: 0.030, ampZ: 0.020,
      speechBoost: 1.8, poseBoost: 1.5,
    },
  },
  {
    pattern: /^(mixamorig:?)?Spine2$/i,
    config: {
      seed: 13, group: 'spine',
      freqX: 0.30, freqY: 0.25, freqZ: 0.35,
      ampX: 0.030, ampY: 0.035, ampZ: 0.025,
      speechBoost: 2.0, poseBoost: 1.8,
    },
  },
  // Shoulders
  {
    pattern: /^(mixamorig:?)?LeftShoulder$/i,
    config: {
      seed: 21, group: 'leftArm',
      freqX: 0.35, freqY: 0.30, freqZ: 0.40,
      ampX: 0.030, ampY: 0.020, ampZ: 0.025,
      speechBoost: 2.5, poseBoost: 2.0,
    },
  },
  {
    pattern: /^(mixamorig:?)?RightShoulder$/i,
    config: {
      seed: 22, group: 'rightArm',
      freqX: 0.33, freqY: 0.32, freqZ: 0.38,
      ampX: 0.030, ampY: 0.020, ampZ: 0.025,
      speechBoost: 2.5, poseBoost: 2.0,
    },
  },
  // Upper arms
  {
    pattern: /^(mixamorig:?)?LeftArm$/i,
    config: {
      seed: 31, group: 'leftArm',
      freqX: 0.40, freqY: 0.35, freqZ: 0.30,
      ampX: 0.040, ampY: 0.035, ampZ: 0.030,
      speechBoost: 3.0, poseBoost: 3.0,
    },
  },
  {
    pattern: /^(mixamorig:?)?RightArm$/i,
    config: {
      seed: 32, group: 'rightArm',
      freqX: 0.38, freqY: 0.37, freqZ: 0.32,
      ampX: 0.040, ampY: 0.035, ampZ: 0.030,
      speechBoost: 3.0, poseBoost: 3.0,
    },
  },
  // Forearms
  {
    pattern: /^(mixamorig:?)?LeftForeArm$/i,
    config: {
      seed: 41, group: 'leftArm',
      freqX: 0.45, freqY: 0.40, freqZ: 0.35,
      ampX: 0.030, ampY: 0.025, ampZ: 0.020,
      speechBoost: 2.5, poseBoost: 2.5,
    },
  },
  {
    pattern: /^(mixamorig:?)?RightForeArm$/i,
    config: {
      seed: 42, group: 'rightArm',
      freqX: 0.43, freqY: 0.42, freqZ: 0.37,
      ampX: 0.030, ampY: 0.025, ampZ: 0.020,
      speechBoost: 2.5, poseBoost: 2.5,
    },
  },
];

// MediaPipe Pose Landmark indices
const LM_LEFT_SHOULDER  = 11;
const LM_RIGHT_SHOULDER = 12;
const LM_LEFT_ELBOW     = 13;
const LM_RIGHT_ELBOW    = 14;
const LM_LEFT_WRIST     = 15;
const LM_RIGHT_WRIST    = 16;
const LM_LEFT_HIP       = 23;
const LM_RIGHT_HIP      = 24;

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

    /** @private Smoothed speech intensity */
    this._speechEnv = 0;

    /** @private Smoothed pose activity per group (0..1) */
    this._poseActivity = {
      spine: 0,
      leftArm: 0,
      rightArm: 0,
    };

    /** @private Smoothed spine lean for direct spine tracking */
    this._spineLean = { pitch: 0, roll: 0 };

    /** @private Smoothed arm world-space directions (for retargeting) */
    this._armDirs = null;

    /** @private Reusable temp objects */
    this._tmpQuat = new THREE.Quaternion();
    this._tmpEuler = new THREE.Euler();
    this._deltaQuat = new THREE.Quaternion();
  }

  /**
   * Scan the avatar's skeleton and register matching bones.
   * @param {THREE.Object3D} avatarRoot
   */
  registerAvatar(avatarRoot) {
    this._targets = [];
    this._armDirs = null;
    if (!avatarRoot) return;

    // Force-update world matrices so parent transforms are fresh
    avatarRoot.updateMatrixWorld(true);

    avatarRoot.traverse((obj) => {
      if (!obj.isBone && obj.type !== 'Bone') return;

      for (const rule of BONE_RULES) {
        if (rule.pattern.test(obj.name)) {
          const primaryAxis = inferPrimaryAxis(obj);

          this._targets.push({
            bone: obj,
            canonName: obj.name.replace(/^(mixamorig:?)?/i, ''),
            baseQuat: obj.quaternion.clone(),
            primaryAxis: primaryAxis,
            noise: new Noise1D(rule.config.seed),
            config: rule.config,
          });
          break;
        }
      }
    });

    const retargetable = this._targets.filter((t) => t.primaryAxis).length;
    console.log(
      `[IdleGesture] Registered ${this._targets.length} bones ` +
      `(${retargetable} retargetable):`,
      this._targets.map((t) => t.bone.name).join(', ')
    );

    if (this._targets.length === 0) {
      console.warn('[IdleGesture] No matching bones found.');
    }
  }

  /** Clear registration. */
  clear() {
    for (const t of this._targets) {
      t.bone.quaternion.copy(t.baseQuat);
    }
    this._targets = [];
    this._poseActivity = { spine: 0, leftArm: 0, rightArm: 0 };
    this._spineLean = { pitch: 0, roll: 0 };
    this._armDirs = null;
  }

  // ==========================================================================
  // Mode 1: Pure noise (no pose data)
  // ==========================================================================

  /**
   * @param {number} dt - ms
   * @param {Object<string, number>} blendShapes
   */
  update(dt, blendShapes) {
    if (!this.enabled || this._targets.length === 0) {
      for (const t of this._targets) t.bone.quaternion.slerp(t.baseQuat, 0.2);
      return;
    }

    this._time += dt / 1000;
    this._updateSpeechEnvelope(blendShapes);

    for (const t of this._targets) {
      this._applyNoiseToBone(t, 0);
    }
  }

  // ==========================================================================
  // Mode 2: Pose-driven retargeting + noise
  // ==========================================================================

  /**
   * @param {number} dt - ms
   * @param {Object<string, number>} blendShapes
   * @param {Array} worldLandmarks
   * @param {boolean} mirrored
   */
  updateWithPose(dt, blendShapes, worldLandmarks, mirrored) {
    if (!this.enabled || this._targets.length === 0) {
      for (const t of this._targets) t.bone.quaternion.slerp(t.baseQuat, 0.2);
      return;
    }

    this._time += dt / 1000;
    this._updateSpeechEnvelope(blendShapes);

    // Compute pose state: arm directions + spine lean
    this._updatePoseState(worldLandmarks, mirrored);

    for (const t of this._targets) {
      const group = t.config.group;

      if (group === 'spine') {
        this._applySpineWithLean(t);
      } else if (this._armDirs && t.primaryAxis) {
        // Arms: REAL retargeting to MediaPipe pose direction
        this._applyRetargetedArm(t);
      } else {
        // Fallback: noise only (when retargeting unavailable)
        this._applyNoiseToBone(t, 0);
      }
    }
  }

  // ==========================================================================
  // Pose state computation
  // ==========================================================================

  /**
   * Compute pose state from world landmarks:
   *  - World-space direction vectors for arm/forearm bones
   *  - Spine lean
   *  - Activity scores (for spine noise modulation)
   * @private
   */
  _updatePoseState(worldLandmarks, mirrored) {
    if (!worldLandmarks || worldLandmarks.length < 25) {
      this._armDirs = null;
      return;
    }

    // MediaPipe → Three.js: (x, -y, -z)
    // Mirror: when mirrored=true (selfie), swap left/right AND negate x
    const mirrorX = mirrored ? -1 : 1;
    const toVec3 = (lm) => new THREE.Vector3(mirrorX * lm.x, -lm.y, -lm.z);

    // Avatar L/R landmark mapping
    const avLS = mirrored ? LM_RIGHT_SHOULDER : LM_LEFT_SHOULDER;
    const avRS = mirrored ? LM_LEFT_SHOULDER  : LM_RIGHT_SHOULDER;
    const avLE = mirrored ? LM_RIGHT_ELBOW    : LM_LEFT_ELBOW;
    const avRE = mirrored ? LM_LEFT_ELBOW     : LM_RIGHT_ELBOW;
    const avLW = mirrored ? LM_RIGHT_WRIST    : LM_LEFT_WRIST;
    const avRW = mirrored ? LM_LEFT_WRIST     : LM_RIGHT_WRIST;
    const avLH = mirrored ? LM_RIGHT_HIP      : LM_LEFT_HIP;
    const avRH = mirrored ? LM_LEFT_HIP       : LM_RIGHT_HIP;

    // Visibility check
    const minVis = 0.5;
    const visLS = worldLandmarks[avLS]?.visibility ?? 1.0;
    const visRS = worldLandmarks[avRS]?.visibility ?? 1.0;
    if (visLS < minVis && visRS < minVis) {
      this._armDirs = null;
      return;
    }

    const lShoulder = toVec3(worldLandmarks[avLS]);
    const rShoulder = toVec3(worldLandmarks[avRS]);
    const lElbow    = toVec3(worldLandmarks[avLE]);
    const rElbow    = toVec3(worldLandmarks[avRE]);
    const lWrist    = toVec3(worldLandmarks[avLW]);
    const rWrist    = toVec3(worldLandmarks[avRW]);
    const lHip      = toVec3(worldLandmarks[avLH]);
    const rHip      = toVec3(worldLandmarks[avRH]);

    // Compute direction vectors (world-space, normalized)
    const lUpperArm = new THREE.Vector3().subVectors(lElbow, lShoulder).normalize();
    const rUpperArm = new THREE.Vector3().subVectors(rElbow, rShoulder).normalize();
    const lForeArm  = new THREE.Vector3().subVectors(lWrist, lElbow).normalize();
    const rForeArm  = new THREE.Vector3().subVectors(rWrist, rElbow).normalize();

    // Low-pass filter to reduce jitter
    if (!this._armDirs) {
      this._armDirs = {
        leftUpper:  lUpperArm.clone(),
        rightUpper: rUpperArm.clone(),
        leftFore:   lForeArm.clone(),
        rightFore:  rForeArm.clone(),
      };
    } else {
      const a = 0.35;
      this._armDirs.leftUpper.lerp(lUpperArm, a).normalize();
      this._armDirs.rightUpper.lerp(rUpperArm, a).normalize();
      this._armDirs.leftFore.lerp(lForeArm, a).normalize();
      this._armDirs.rightFore.lerp(rForeArm, a).normalize();
    }

    // Spine lean (existing logic)
    const midShoulder = lShoulder.clone().add(rShoulder).multiplyScalar(0.5);
    const midHip = lHip.clone().add(rHip).multiplyScalar(0.5);
    const spineDir = midShoulder.clone().sub(midHip).normalize();
    const rawSpinePitch = Math.atan2(-spineDir.z, spineDir.y);
    const rawSpineRoll  = Math.atan2(spineDir.x, spineDir.y);
    const rawSpineActivity = Math.min(1,
      (Math.abs(rawSpinePitch) + Math.abs(rawSpineRoll)) * 3
    );

    // Activity scores (spine only — arms are retargeted directly)
    const alpha = 0.06;
    this._poseActivity.spine += (rawSpineActivity - this._poseActivity.spine) * alpha;
    this._poseActivity.leftArm  = 0;
    this._poseActivity.rightArm = 0;

    // Smooth spine lean
    const leanAlpha = 0.05;
    this._spineLean.pitch += (rawSpinePitch - this._spineLean.pitch) * leanAlpha;
    this._spineLean.roll  += (rawSpineRoll  - this._spineLean.roll)  * leanAlpha;
  }

  // ==========================================================================
  // Bone application
  // ==========================================================================

  /**
   * Apply noise to a bone, modulated by pose activity and speech.
   * @private
   */
  _applyNoiseToBone(target, poseActivity) {
    const cfg = target.config;

    const idleAmp = 0.15;
    const speechAmp = this._speechEnv * cfg.speechBoost;
    const poseAmp = poseActivity * (cfg.poseBoost || 0);
    const totalAmp = (idleAmp + speechAmp + poseAmp) * this.intensity;

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
    target.bone.quaternion.slerp(this._tmpQuat, 0.35);
  }

  /**
   * Apply real retargeting to an arm/forearm bone.
   * Uses MediaPipe world-space direction + tiny idle noise on top.
   * @private
   */
  _applyRetargetedArm(target) {
    const name = target.canonName;
    const cfg = target.config;

    // Pick the correct world direction for this bone
    let desiredWorldDir;
    if (name === 'LeftArm')           desiredWorldDir = this._armDirs.leftUpper;
    else if (name === 'RightArm')     desiredWorldDir = this._armDirs.rightUpper;
    else if (name === 'LeftForeArm')  desiredWorldDir = this._armDirs.leftFore;
    else if (name === 'RightForeArm') desiredWorldDir = this._armDirs.rightFore;
    else if (name === 'LeftShoulder' || name === 'RightShoulder') {
      // Shoulders use noise only
      this._applyNoiseToBone(target, 0);
      return;
    } else {
      this._applyNoiseToBone(target, 0);
      return;
    }

    // Compute the retargeted local quaternion
    const retargetedQuat = computeRetargetedQuat(
      target.bone,
      target.primaryAxis,
      desiredWorldDir
    );

    if (!retargetedQuat) {
      this._applyNoiseToBone(target, 0);
      return;
    }

    // Clamp to safe range (prevents extreme bends)
    const maxAngle = (name === 'LeftForeArm' || name === 'RightForeArm')
      ? Math.PI * 0.6   // ~108°
      : Math.PI * 0.5;  // ~90°
    clampQuatAngle(retargetedQuat, target.baseQuat, maxAngle);

    // Add tiny noise on top for natural micro-motion
    const noiseAmp = 0.08 * this.intensity;
    const nx = target.noise.fbm(this._time * cfg.freqX, 2) * cfg.ampX * noiseAmp;
    const ny = target.noise.fbm(this._time * cfg.freqY + 100, 2) * cfg.ampY * noiseAmp;
    const nz = target.noise.fbm(this._time * cfg.freqZ + 200, 2) * cfg.ampZ * noiseAmp;
    this._tmpEuler.set(nx, ny, nz, 'XYZ');
    this._deltaQuat.setFromEuler(this._tmpEuler);
    retargetedQuat.multiply(this._deltaQuat);

    // Slerp toward target for smooth tracking
    target.bone.quaternion.slerp(retargetedQuat, 0.25);
  }

  /**
   * Apply spine bone rotation: direct lean from pose + noise.
   * @private
   */
  _applySpineWithLean(target) {
    const cfg = target.config;
    const name = target.canonName;

    const weight = name === 'Spine' ? 0.20 : name === 'Spine1' ? 0.25 : 0.35;
    const maxLean = 0.15;

    const leanX = THREE.MathUtils.clamp(this._spineLean.pitch * weight, -maxLean, maxLean);
    const leanZ = THREE.MathUtils.clamp(this._spineLean.roll  * weight, -maxLean, maxLean);

    const idleAmp = 0.12;
    const speechAmp = this._speechEnv * cfg.speechBoost;
    const poseAmp = this._poseActivity.spine * (cfg.poseBoost || 0);
    const noiseAmp = (idleAmp + speechAmp + poseAmp) * this.intensity;

    const nx = target.noise.fbm(this._time * cfg.freqX + 0, 3);
    const ny = target.noise.fbm(this._time * cfg.freqY + 100, 3);
    const nz = target.noise.fbm(this._time * cfg.freqZ + 200, 3);

    this._tmpEuler.set(
      leanX + nx * cfg.ampX * noiseAmp,
      ny * cfg.ampY * noiseAmp,
      leanZ + nz * cfg.ampZ * noiseAmp,
      'XYZ'
    );
    this._deltaQuat.setFromEuler(this._tmpEuler);
    this._tmpQuat.copy(target.baseQuat).multiply(this._deltaQuat);
    target.bone.quaternion.slerp(this._tmpQuat, 0.35);
  }

  // ==========================================================================
  // Shared
  // ==========================================================================

  /** @private */
  _updateSpeechEnvelope(blendShapes) {
    const jawOpen = blendShapes?.jawOpen || 0;
    const rawSpeech = Math.max(0, (jawOpen - 0.04) / 0.35);
    const targetSpeech = Math.min(1, rawSpeech);
    const coef = targetSpeech > this._speechEnv ? 0.25 : 0.04;
    this._speechEnv += (targetSpeech - this._speechEnv) * coef;
  }
}
