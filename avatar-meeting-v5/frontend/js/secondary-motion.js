/**
 * @fileoverview Secondary motion controller — Follow Through physics.
 *
 * Disney's 12 Principles: "Follow Through and Overlapping Action"
 * When the head turns rapidly, secondary elements (head itself and any
 * hair bones) should slightly overshoot and then settle.
 *
 * Two sub-systems:
 *   1. HeadFollowThrough — adds spring-damper overshoot to head rotation.
 *   2. HairBonePhysics   — auto-detects hair bones and applies inertia.
 */

import * as THREE from 'three';

// ============================================================================
// Head Follow Through
// ============================================================================
export class HeadFollowThrough {
  constructor() {
    /** @type {THREE.Bone|null} */
    this._headBone = null;

    this._velX = 0;
    this._velY = 0;
    this._velZ = 0;
    this._offsetX = 0;
    this._offsetY = 0;
    this._offsetZ = 0;

    this._prevRotX = 0;
    this._prevRotY = 0;
    this._prevRotZ = 0;
    this._hasPrev = false;

    this.stiffness = 300;
    this.damping = 20;

    this.enabled = true;
    /** @type {number} 0..2, multiplies the overshoot effect */
    this.strength = 1.0;

    this._tmpEuler = new THREE.Euler();
    this._tmpQuat = new THREE.Quaternion();
  }

  /** @param {THREE.Bone|null} headBone */
  setHeadBone(headBone) {
    this._headBone = headBone;
    this._hasPrev = false;
    this._velX = this._velY = this._velZ = 0;
    this._offsetX = this._offsetY = this._offsetZ = 0;
  }

  /** @param {number} dt - seconds */
  update(dt) {
    if (!this.enabled || !this._headBone || dt <= 0) return;
    dt = Math.min(dt, 0.05);

    const curX = this._headBone.rotation.x;
    const curY = this._headBone.rotation.y;
    const curZ = this._headBone.rotation.z;

    if (!this._hasPrev) {
      this._prevRotX = curX;
      this._prevRotY = curY;
      this._prevRotZ = curZ;
      this._hasPrev = true;
      return;
    }

    const dRotX = (curX - this._prevRotX) / dt;
    const dRotY = (curY - this._prevRotY) / dt;
    const dRotZ = (curZ - this._prevRotZ) / dt;

    this._prevRotX = curX;
    this._prevRotY = curY;
    this._prevRotZ = curZ;

    const k = this.stiffness;
    const c = this.damping;
    const exciteScale = 0.003 * this.strength;

    this._updateAxis('X', dRotX, exciteScale, k, c, dt);
    this._updateAxis('Y', dRotY, exciteScale, k, c, dt);
    this._updateAxis('Z', dRotZ, exciteScale, k, c, dt);

    const ox = this._offsetX;
    const oy = this._offsetY;
    const oz = this._offsetZ;

    if (Math.abs(ox) > 1e-5 || Math.abs(oy) > 1e-5 || Math.abs(oz) > 1e-5) {
      this._tmpEuler.set(ox, oy, oz, 'XYZ');
      this._tmpQuat.setFromEuler(this._tmpEuler);
      this._headBone.quaternion.multiply(this._tmpQuat);
    }
  }

  /** @private */
  _updateAxis(axis, angularVelocity, exciteScale, k, c, dt) {
    const prop = '_offset' + axis;
    const velProp = '_vel' + axis;

    this[velProp] += angularVelocity * exciteScale;

    const acc = -k * this[prop] - c * this[velProp];
    this[velProp] += acc * dt;

    const maxVel = 5.0;
    if (this[velProp] >  maxVel) this[velProp] =  maxVel;
    if (this[velProp] < -maxVel) this[velProp] = -maxVel;

    this[prop] += this[velProp] * dt;

    const maxAngle = 0.05;  // ~3°
    if (this[prop] >  maxAngle) this[prop] =  maxAngle;
    if (this[prop] < -maxAngle) this[prop] = -maxAngle;
  }

  setEnabled(v) {
    this.enabled = !!v;
    if (!v) {
      this._offsetX = this._offsetY = this._offsetZ = 0;
      this._velX = this._velY = this._velZ = 0;
    }
  }

  setStrength(v) {
    this.strength = Math.max(0, Math.min(2, v));
  }
}

// ============================================================================
// Hair Bone Physics
// ============================================================================
export class HairBonePhysics {
  constructor() {
    /** @type {Array<{bone:THREE.Bone, restQuat:THREE.Quaternion, velX:number, velY:number, velZ:number}>} */
    this._hairBones = [];
    /** @type {THREE.Bone|null} */
    this._headBone = null;

    this.enabled = true;
    this.stiffness = 100;
    this.damping = 8;
    this.strength = 1.0;

    this._prevHeadQuat = new THREE.Quaternion();
    this._hasPrev = false;

    this._tmpQuat = new THREE.Quaternion();
    this._tmpEuler = new THREE.Euler();
  }

  /**
   * @param {THREE.Object3D} avatarRoot
   * @param {THREE.Bone|null} headBone
   */
  registerAvatar(avatarRoot, headBone) {
    this._hairBones = [];
    this._headBone = headBone;
    this._hasPrev = false;

    if (!avatarRoot || !headBone) return;

    avatarRoot.traverse((obj) => {
      if (!obj.isBone && obj.type !== 'Bone') return;
      if (!/hair/i.test(obj.name)) return;

      this._hairBones.push({
        bone: obj,
        restQuat: obj.quaternion.clone(),
        velX: 0,
        velY: 0,
        velZ: 0,
      });
    });

    if (this._hairBones.length > 0) {
      console.log(
        `[HairPhysics] Found ${this._hairBones.length} hair bones:`,
        this._hairBones.map((h) => h.bone.name).join(', ')
      );
    } else {
      console.log('[HairPhysics] No hair bones found (static hair mesh — normal for Avaturn T2)');
    }
  }

  clear() {
    for (const h of this._hairBones) {
      h.bone.quaternion.copy(h.restQuat);
    }
    this._hairBones = [];
    this._hasPrev = false;
  }

  /** @param {number} dt - seconds */
  update(dt) {
    if (!this.enabled || this._hairBones.length === 0 || !this._headBone || dt <= 0) return;
    dt = Math.min(dt, 0.05);

    const hq = this._headBone.quaternion;
    if (!this._hasPrev) {
      this._prevHeadQuat.copy(hq);
      this._hasPrev = true;
      return;
    }

    this._tmpQuat.copy(this._prevHeadQuat).invert().multiply(hq);
    this._tmpEuler.setFromQuaternion(this._tmpQuat, 'XYZ');
    const headVelX = this._tmpEuler.x / dt;
    const headVelY = this._tmpEuler.y / dt;
    const headVelZ = this._tmpEuler.z / dt;
    this._prevHeadQuat.copy(hq);

    const c = this.damping;
    const excite = -0.01 * this.strength;
    const maxAngle = 0.08;  // ~4.6°

    for (const h of this._hairBones) {
      h.velX += headVelX * excite;
      h.velX += (-c * h.velX) * dt;
      if (h.velX >  3) h.velX =  3;
      if (h.velX < -3) h.velX = -3;

      h.velY += headVelY * excite;
      h.velY += (-c * h.velY) * dt;
      if (h.velY >  3) h.velY =  3;
      if (h.velY < -3) h.velY = -3;

      h.velZ += headVelZ * excite;
      h.velZ += (-c * h.velZ) * dt;
      if (h.velZ >  3) h.velZ =  3;
      if (h.velZ < -3) h.velZ = -3;

      let ox = h.velX * dt * 5;
      let oy = h.velY * dt * 5;
      let oz = h.velZ * dt * 5;
      if (ox >  maxAngle) ox =  maxAngle; else if (ox < -maxAngle) ox = -maxAngle;
      if (oy >  maxAngle) oy =  maxAngle; else if (oy < -maxAngle) oy = -maxAngle;
      if (oz >  maxAngle) oz =  maxAngle; else if (oz < -maxAngle) oz = -maxAngle;

      this._tmpEuler.set(ox, oy, oz, 'XYZ');
      this._tmpQuat.setFromEuler(this._tmpEuler);
      h.bone.quaternion.copy(h.restQuat).multiply(this._tmpQuat);
    }
  }

  setEnabled(v) { this.enabled = !!v; }
  setStrength(v) { this.strength = Math.max(0, Math.min(2, v)); }
}

// ============================================================================
// Combined wrapper
// ============================================================================
export class SecondaryMotionController {
  constructor() {
    this.headFollowThrough = new HeadFollowThrough();
    this.hairPhysics = new HairBonePhysics();
  }

  registerAvatar(avatarRoot, headBone) {
    this.headFollowThrough.setHeadBone(headBone);
    this.hairPhysics.registerAvatar(avatarRoot, headBone);
  }

  clear() {
    this.headFollowThrough.setHeadBone(null);
    this.hairPhysics.clear();
  }

  update(dt) {
    this.headFollowThrough.update(dt);
    this.hairPhysics.update(dt);
  }
}
