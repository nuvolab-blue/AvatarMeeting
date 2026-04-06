/**
 * @fileoverview BlendShape → Mesh Vertex Displacement converter.
 *
 * Converts MediaPipe's 52 BlendShape coefficients + head pose into
 * a Float32Array of per-vertex (dx, dy) displacements for WebGLWarp.
 *
 * Uses Gaussian displacement fields centered on facial control points.
 * Glasses zone protection reduces displacement to 5% in the bridge/frame area.
 */

class BlendShapeDriver {
  /**
   * @param {number} cols - Mesh columns (default 20)
   * @param {number} rows - Mesh rows (default 24)
   * @param {number} imageWidth
   * @param {number} imageHeight
   */
  constructor(cols = 20, rows = 24, imageWidth = 640, imageHeight = 480) {
    /** @private */ this._cols = cols;
    /** @private */ this._rows = rows;
    /** @private */ this._vCols = cols + 1;
    /** @private */ this._vRows = rows + 1;
    /** @private */ this._vertexCount = this._vCols * this._vRows;
    /** @private */ this._imgW = imageWidth;
    /** @private */ this._imgH = imageHeight;

    // Reuse across frames to avoid GC
    /** @private */ this._displacements = new Float32Array(this._vertexCount * 2);

    // Pre-compute vertex normalized positions (0-1 in texture space)
    /** @private */ this._vertexNorm = new Float32Array(this._vertexCount * 2);
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        const idx = (r * this._vCols + c) * 2;
        this._vertexNorm[idx + 0] = c / cols; // u
        this._vertexNorm[idx + 1] = r / rows; // v
      }
    }

    /** @type {boolean} */ this.hasGlasses = false;
  }

  /**
   * Convert BlendShape coefficients + head pose to vertex displacements.
   * @param {Object<string, number>} bs - BlendShape coefficients (0-1)
   * @param {{yaw: number, pitch: number, roll: number}} pose - Head pose in degrees
   * @param {boolean} hasGlasses
   * @returns {Float32Array} Per-vertex (dx, dy) in NDC
   */
  computeDisplacements(bs, pose, hasGlasses) {
    const d = this._displacements;
    d.fill(0);
    this.hasGlasses = hasGlasses;

    const g = (name) => bs[name] || 0;

    // ====================================================================
    // Mouth
    // ====================================================================

    // Jaw open: lower lip + jaw moves down
    const jawOpen = g('jawOpen');
    if (jawOpen > 0.01) {
      // Lower lip center
      this._displace(0.50, 0.68, 0, jawOpen * 0.12, 0.12, 0.06, d, false);
      // Jaw
      this._displace(0.50, 0.75, 0, jawOpen * 0.08, 0.18, 0.08, d, false);
      // Upper lip slight upward
      this._displace(0.50, 0.60, 0, -jawOpen * 0.015, 0.10, 0.03, d, false);
    }

    // Mouth close
    const mouthClose = g('mouthClose');
    if (mouthClose > 0.01) {
      this._displace(0.50, 0.65, 0, -mouthClose * 0.015, 0.10, 0.04, d, false);
    }

    // Smile
    const smileL = g('mouthSmileLeft');
    const smileR = g('mouthSmileRight');
    if (smileL > 0.01) {
      this._displace(0.38, 0.63, -smileL * 0.025, -smileL * 0.03, 0.06, 0.04, d, false);
    }
    if (smileR > 0.01) {
      this._displace(0.62, 0.63, smileR * 0.025, -smileR * 0.03, 0.06, 0.04, d, false);
    }

    // Frown
    const frownL = g('mouthFrownLeft');
    const frownR = g('mouthFrownRight');
    if (frownL > 0.01) {
      this._displace(0.38, 0.65, 0, frownL * 0.018, 0.05, 0.03, d, false);
    }
    if (frownR > 0.01) {
      this._displace(0.62, 0.65, 0, frownR * 0.018, 0.05, 0.03, d, false);
    }

    // Pucker
    const pucker = g('mouthPucker');
    if (pucker > 0.01) {
      this._displace(0.42, 0.63, pucker * 0.012, 0, 0.05, 0.04, d, false);
      this._displace(0.58, 0.63, -pucker * 0.012, 0, 0.05, 0.04, d, false);
    }

    // Funnel
    const funnel = g('mouthFunnel');
    if (funnel > 0.01) {
      this._displace(0.42, 0.63, funnel * 0.008, 0, 0.04, 0.04, d, false);
      this._displace(0.58, 0.63, -funnel * 0.008, 0, 0.04, 0.04, d, false);
    }

    // Stretch
    const stretchL = g('mouthStretchLeft');
    const stretchR = g('mouthStretchRight');
    if (stretchL > 0.01) {
      this._displace(0.38, 0.63, -stretchL * 0.018, 0, 0.05, 0.03, d, false);
    }
    if (stretchR > 0.01) {
      this._displace(0.62, 0.63, stretchR * 0.018, 0, 0.05, 0.03, d, false);
    }

    // ====================================================================
    // Eyes — blink
    // ====================================================================

    const blinkL = g('eyeBlinkLeft');
    const blinkR = g('eyeBlinkRight');
    if (blinkL > 0.01) {
      // Upper eyelid moves down
      this._displace(0.36, 0.38, 0, blinkL * 0.04, 0.06, 0.03, d, hasGlasses);
    }
    if (blinkR > 0.01) {
      this._displace(0.64, 0.38, 0, blinkR * 0.04, 0.06, 0.03, d, hasGlasses);
    }

    // Eye wide
    const wideL = g('eyeWideLeft');
    const wideR = g('eyeWideRight');
    if (wideL > 0.01) {
      this._displace(0.36, 0.37, 0, -wideL * 0.012, 0.05, 0.03, d, hasGlasses);
    }
    if (wideR > 0.01) {
      this._displace(0.64, 0.37, 0, -wideR * 0.012, 0.05, 0.03, d, hasGlasses);
    }

    // Eye squint
    const squintL = g('eyeSquintLeft');
    const squintR = g('eyeSquintRight');
    if (squintL > 0.01) {
      this._displace(0.36, 0.40, 0, -squintL * 0.008, 0.05, 0.02, d, hasGlasses);
    }
    if (squintR > 0.01) {
      this._displace(0.64, 0.40, 0, -squintR * 0.008, 0.05, 0.02, d, hasGlasses);
    }

    // ====================================================================
    // Eyebrows
    // ====================================================================

    const browInnerUp = g('browInnerUp');
    if (browInnerUp > 0.01) {
      this._displace(0.43, 0.30, 0, -browInnerUp * 0.035, 0.06, 0.03, d, hasGlasses);
      this._displace(0.57, 0.30, 0, -browInnerUp * 0.035, 0.06, 0.03, d, hasGlasses);
    }

    const browDownL = g('browDownLeft');
    const browDownR = g('browDownRight');
    if (browDownL > 0.01) {
      this._displace(0.36, 0.31, 0, browDownL * 0.015, 0.05, 0.025, d, hasGlasses);
    }
    if (browDownR > 0.01) {
      this._displace(0.64, 0.31, 0, browDownR * 0.015, 0.05, 0.025, d, hasGlasses);
    }

    const browOuterUpL = g('browOuterUpLeft');
    const browOuterUpR = g('browOuterUpRight');
    if (browOuterUpL > 0.01) {
      this._displace(0.28, 0.30, 0, -browOuterUpL * 0.018, 0.05, 0.025, d, hasGlasses);
    }
    if (browOuterUpR > 0.01) {
      this._displace(0.72, 0.30, 0, -browOuterUpR * 0.018, 0.05, 0.025, d, hasGlasses);
    }

    // ====================================================================
    // Cheeks & nose
    // ====================================================================

    const cheekPuff = g('cheekPuff');
    if (cheekPuff > 0.01) {
      this._displace(0.30, 0.55, -cheekPuff * 0.015, 0, 0.06, 0.06, d, false);
      this._displace(0.70, 0.55, cheekPuff * 0.015, 0, 0.06, 0.06, d, false);
    }

    const noseSneerL = g('noseSneerLeft');
    const noseSneerR = g('noseSneerRight');
    if (noseSneerL > 0.01) {
      this._displace(0.43, 0.50, -noseSneerL * 0.006, -noseSneerL * 0.008, 0.04, 0.03, d, false);
    }
    if (noseSneerR > 0.01) {
      this._displace(0.57, 0.50, noseSneerR * 0.006, -noseSneerR * 0.008, 0.04, 0.03, d, false);
    }

    // ====================================================================
    // Head pose (global transform)
    // ====================================================================

    if (pose) {
      this._applyHeadPose(pose, d);
    }

    return d;
  }

  // ==========================================================================
  // Private: Gaussian displacement
  // ==========================================================================

  /**
   * Apply Gaussian displacement around a control point.
   * @private
   * @param {number} cx - Control point X in texture coords (0-1)
   * @param {number} cy - Control point Y in texture coords (0-1)
   * @param {number} dx - Displacement X in NDC
   * @param {number} dy - Displacement Y in NDC
   * @param {number} sigmaX - Gaussian spread X in texture coords
   * @param {number} sigmaY - Gaussian spread Y in texture coords
   * @param {Float32Array} d - Output displacement array
   * @param {boolean} rigid - Apply glasses zone attenuation
   */
  _displace(cx, cy, dx, dy, sigmaX, sigmaY, d, rigid) {
    const invSx2 = 1.0 / (sigmaX * sigmaX);
    const invSy2 = 1.0 / (sigmaY * sigmaY);
    const vn = this._vertexNorm;
    const n = this._vertexCount;

    for (let i = 0; i < n; i++) {
      const vx = vn[i * 2];
      const vy = vn[i * 2 + 1];

      const ddx = vx - cx;
      const ddy = vy - cy;
      let weight = Math.exp(-(ddx * ddx * invSx2 + ddy * ddy * invSy2));

      // Glasses zone attenuation
      if (rigid && this.hasGlasses && this._inGlassesZone(vx, vy)) {
        weight *= 0.05;
      }

      // Skip negligible weights
      if (weight < 0.001) continue;

      d[i * 2] += dx * weight;
      d[i * 2 + 1] += dy * weight;
    }
  }

  /**
   * Check if a point is in the glasses zone.
   * @private
   * @param {number} x - Texture X (0-1)
   * @param {number} y - Texture Y (0-1)
   * @returns {boolean}
   */
  _inGlassesZone(x, y) {
    return y >= 0.34 && y <= 0.48 && x >= 0.25 && x <= 0.75;
  }

  /**
   * Apply head pose as global vertex transform.
   * @private
   * @param {{yaw: number, pitch: number, roll: number}} pose - Degrees
   * @param {Float32Array} d - Displacement array to modify
   */
  _applyHeadPose(pose, d) {
    const yawRad = (pose.yaw || 0) * Math.PI / 180;
    const pitchRad = (pose.pitch || 0) * Math.PI / 180;
    const rollRad = (pose.roll || 0) * Math.PI / 180;

    // Scale factors for perspective approximation
    const yawScale = 0.0015;   // Degrees → NDC displacement
    const pitchScale = 0.0012;
    const rollScale = 0.002;

    const cosR = Math.cos(rollRad * rollScale * 50); // subtle rotation
    const sinR = Math.sin(rollRad * rollScale * 50);

    const n = this._vertexCount;

    for (let i = 0; i < n; i++) {
      const vx = this._vertexNorm[i * 2] - 0.5;     // Center at 0
      const vy = this._vertexNorm[i * 2 + 1] - 0.5;

      // Yaw: horizontal shift proportional to vertical distance from center
      // Creates a subtle perspective effect
      const yawDisp = pose.yaw * yawScale;

      // Pitch: vertical shift
      const pitchDisp = pose.pitch * pitchScale;

      // Roll: rotation around center
      const rx = vx * cosR - vy * sinR - vx;
      const ry = vx * sinR + vy * cosR - vy;

      d[i * 2] += yawDisp + rx;
      // Note: NDC Y is flipped (positive = up), but displacement is in NDC space
      // and our vertex Y goes from +1 (top) to -1 (bottom)
      d[i * 2 + 1] += -pitchDisp + ry;
    }
  }

  /**
   * Get the current mouth center in texture coordinates.
   * Used for the mouth interior shader effect.
   * @param {Object<string, number>} bs - BlendShapes
   * @returns {{x: number, y: number}} Texture coordinates
   */
  getMouthCenter(bs) {
    const jawOpen = bs.jawOpen || 0;
    return {
      x: 0.5,
      y: 0.62 + jawOpen * 0.03, // Shifts down slightly when open
    };
  }
}

window.BlendShapeDriver = BlendShapeDriver;
