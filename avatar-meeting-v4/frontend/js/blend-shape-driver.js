/**
 * @fileoverview BlendShape → Mesh Vertex Displacement converter.
 *
 * Converts MediaPipe's 52 BlendShape coefficients + head pose into
 * a Float32Array of per-vertex (dx, dy) displacements for WebGLWarp.
 *
 * ★ v4.1 fixes:
 *   - Face detection on avatar image sets control points dynamically
 *   - All vertical displacement signs corrected (NDC: +y = UP on screen)
 *   - Head pose scale increased for visible movement
 */

class BlendShapeDriver {
  /**
   * @param {number} cols
   * @param {number} rows
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
        this._vertexNorm[idx + 1] = r / rows; // v (0=top, 1=bottom)
      }
    }

    /** @type {boolean} */ this.hasGlasses = false;

    // ★ Dynamic face feature positions in TEXTURE coords (0-1)
    // These are set by detectFace() or fall back to defaults
    /** @private */ this._face = this._defaultFacePositions();
  }

  // ==========================================================================
  // Face detection — sets control points from avatar image
  // ==========================================================================

  /**
   * Detect face features in the avatar image and set control points.
   * Uses FaceDetector API (Chrome native) with canvas fallback.
   * @param {HTMLImageElement|HTMLCanvasElement} image
   * @returns {Promise<boolean>} true if face detected
   */
  async detectFace(image) {
    // Try FaceDetector API (Chrome 70+)
    if ('FaceDetector' in window) {
      try {
        const detector = new FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
        const faces = await detector.detect(image);
        if (faces.length > 0) {
          const face = faces[0];
          const w = image.naturalWidth || image.width;
          const h = image.naturalHeight || image.height;
          const box = face.boundingBox;

          // Normalize to texture coords (0-1)
          const fx = box.x / w;
          const fy = box.y / h;
          const fw = box.width / w;
          const fh = box.height / h;

          // Extract landmark positions if available
          const lm = {};
          if (face.landmarks) {
            for (const l of face.landmarks) {
              const pts = l.locations || l;
              if (Array.isArray(pts) && pts.length > 0) {
                lm[l.type] = { x: pts[0].x / w, y: pts[0].y / h };
              }
            }
          }

          this._setFaceFromBBox(fx, fy, fw, fh, lm);
          console.log(`[BlendShapeDriver] Face detected: box=(${fx.toFixed(2)},${fy.toFixed(2)},${fw.toFixed(2)},${fh.toFixed(2)})`);
          return true;
        }
      } catch (e) {
        console.warn('[BlendShapeDriver] FaceDetector failed:', e.message);
      }
    }

    // Fallback: luminance-based face center estimation
    try {
      const detected = this._detectByLuminance(image);
      if (detected) return true;
    } catch (e) {
      // ignore
    }

    console.log('[BlendShapeDriver] No face detected, using default positions');
    this._face = this._defaultFacePositions();
    return false;
  }

  /**
   * Set face feature positions from a bounding box.
   * @private
   */
  _setFaceFromBBox(fx, fy, fw, fh, landmarks) {
    const cx = fx + fw * 0.5;
    const f = this._face;

    // Use landmarks if available, otherwise derive from bbox
    const leftEye = landmarks.eye
      ? { x: cx - fw * 0.18, y: landmarks.eye.y || fy + fh * 0.35 }
      : { x: cx - fw * 0.18, y: fy + fh * 0.35 };
    const rightEye = landmarks.eye
      ? { x: cx + fw * 0.18, y: landmarks.eye.y || fy + fh * 0.35 }
      : { x: cx + fw * 0.18, y: fy + fh * 0.35 };
    const mouth = landmarks.mouth
      ? landmarks.mouth
      : { x: cx, y: fy + fh * 0.72 };
    const nose = landmarks.nose
      ? landmarks.nose
      : { x: cx, y: fy + fh * 0.55 };

    f.leftEye = leftEye;
    f.rightEye = rightEye;
    f.mouth = mouth;
    f.nose = nose;
    f.center = { x: cx, y: fy + fh * 0.5 };
    f.faceWidth = fw;
    f.faceHeight = fh;

    // Derived positions
    f.leftBrow = { x: leftEye.x, y: leftEye.y - fh * 0.08 };
    f.rightBrow = { x: rightEye.x, y: rightEye.y - fh * 0.08 };
    f.leftBrowOuter = { x: leftEye.x - fw * 0.12, y: leftEye.y - fh * 0.08 };
    f.rightBrowOuter = { x: rightEye.x + fw * 0.12, y: rightEye.y - fh * 0.08 };
    f.jaw = { x: cx, y: mouth.y + fh * 0.12 };
    f.upperLip = { x: cx, y: mouth.y - fh * 0.03 };
    f.lowerLip = { x: cx, y: mouth.y + fh * 0.02 };
    f.leftMouthCorner = { x: cx - fw * 0.15, y: mouth.y };
    f.rightMouthCorner = { x: cx + fw * 0.15, y: mouth.y };
    f.leftCheek = { x: cx - fw * 0.28, y: nose.y + fh * 0.05 };
    f.rightCheek = { x: cx + fw * 0.28, y: nose.y + fh * 0.05 };
    f.leftNose = { x: cx - fw * 0.06, y: nose.y };
    f.rightNose = { x: cx + fw * 0.06, y: nose.y };

    // Glasses zone (relative to face)
    f.glassesTop = leftEye.y - fh * 0.05;
    f.glassesBottom = leftEye.y + fh * 0.12;
    f.glassesLeft = leftEye.x - fw * 0.15;
    f.glassesRight = rightEye.x + fw * 0.15;

    // Displacement scale based on face size (larger face → larger displacement)
    f.scale = fh * 0.5;
  }

  /**
   * Luminance-based face center detection fallback.
   * @private
   */
  _detectByLuminance(image) {
    const oc = document.createElement('canvas');
    const sz = 100; // Small for speed
    const w = image.naturalWidth || image.width;
    const h = image.naturalHeight || image.height;
    const scale = sz / Math.max(w, h);
    oc.width = Math.round(w * scale);
    oc.height = Math.round(h * scale);
    const ctx = oc.getContext('2d');
    ctx.drawImage(image, 0, 0, oc.width, oc.height);
    const data = ctx.getImageData(0, 0, oc.width, oc.height).data;

    // Find skin-colored pixels (simple HSV heuristic)
    let sumX = 0, sumY = 0, count = 0;
    for (let y = 0; y < oc.height; y++) {
      for (let x = 0; x < oc.width; x++) {
        const i = (y * oc.width + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        // Simple skin detection
        if (r > 95 && g > 40 && b > 20 && r > g && r > b &&
            (r - g) > 15 && (r - Math.min(g, b)) > 15) {
          sumX += x; sumY += y; count++;
        }
      }
    }

    if (count < 50) return false;

    const cx = (sumX / count) / oc.width;
    const cy = (sumY / count) / oc.height;

    // Estimate face size from skin pixel spread
    let varX = 0, varY = 0;
    for (let y = 0; y < oc.height; y++) {
      for (let x = 0; x < oc.width; x++) {
        const i = (y * oc.width + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (r > 95 && g > 40 && b > 20 && r > g && r > b &&
            (r - g) > 15 && (r - Math.min(g, b)) > 15) {
          varX += ((x / oc.width) - cx) ** 2;
          varY += ((y / oc.height) - cy) ** 2;
        }
      }
    }
    const stdX = Math.sqrt(varX / count);
    const stdY = Math.sqrt(varY / count);
    const fw = stdX * 4; // rough face width
    const fh = stdY * 4;

    this._setFaceFromBBox(cx - fw / 2, cy - fh / 2, fw, fh, {});
    console.log(`[BlendShapeDriver] Luminance face: center=(${cx.toFixed(2)},${cy.toFixed(2)}), size=(${fw.toFixed(2)},${fh.toFixed(2)})`);
    return true;
  }

  /**
   * Default face positions (for centered portrait photos).
   * @private
   */
  _defaultFacePositions() {
    const f = {};
    f.faceWidth = 0.50;
    f.faceHeight = 0.65;
    f.center = { x: 0.50, y: 0.45 };
    f.leftEye = { x: 0.38, y: 0.38 };
    f.rightEye = { x: 0.62, y: 0.38 };
    f.nose = { x: 0.50, y: 0.50 };
    f.mouth = { x: 0.50, y: 0.62 };
    f.leftBrow = { x: 0.38, y: 0.32 };
    f.rightBrow = { x: 0.62, y: 0.32 };
    f.leftBrowOuter = { x: 0.30, y: 0.32 };
    f.rightBrowOuter = { x: 0.70, y: 0.32 };
    f.jaw = { x: 0.50, y: 0.72 };
    f.upperLip = { x: 0.50, y: 0.60 };
    f.lowerLip = { x: 0.50, y: 0.64 };
    f.leftMouthCorner = { x: 0.40, y: 0.62 };
    f.rightMouthCorner = { x: 0.60, y: 0.62 };
    f.leftCheek = { x: 0.30, y: 0.52 };
    f.rightCheek = { x: 0.70, y: 0.52 };
    f.leftNose = { x: 0.47, y: 0.50 };
    f.rightNose = { x: 0.53, y: 0.50 };
    f.glassesTop = 0.33;
    f.glassesBottom = 0.45;
    f.glassesLeft = 0.25;
    f.glassesRight = 0.75;
    f.scale = 0.325;
    return f;
  }

  // ==========================================================================
  // Main computation
  // ==========================================================================

  /**
   * Convert BlendShape coefficients + head pose to vertex displacements.
   * @param {Object<string, number>} bs
   * @param {{yaw: number, pitch: number, roll: number}} pose
   * @param {boolean} hasGlasses
   * @returns {Float32Array}
   */
  computeDisplacements(bs, pose, hasGlasses) {
    const d = this._displacements;
    d.fill(0);
    this.hasGlasses = hasGlasses;
    const f = this._face;
    const sc = f.scale; // Face-size-based scale

    const g = (name) => bs[name] || 0;

    // ====================================================================
    // NDC coordinate note:
    //   +y = UP on screen,  -y = DOWN on screen
    //   +x = RIGHT on screen, -x = LEFT on screen
    //   "move jaw down" → dy must be NEGATIVE
    //   "raise eyebrow" → dy must be POSITIVE
    // ====================================================================

    // ====================================================================
    // Mouth
    // ====================================================================

    const jawOpen = g('jawOpen');
    if (jawOpen > 0.01) {
      // Lower lip moves DOWN (-y)
      this._displace(f.lowerLip.x, f.lowerLip.y, 0, -jawOpen * 0.22 * sc, 0.12, 0.06, d, false);
      // Jaw moves DOWN (-y)
      this._displace(f.jaw.x, f.jaw.y, 0, -jawOpen * 0.15 * sc, 0.18, 0.08, d, false);
      // Upper lip moves UP slightly (+y)
      this._displace(f.upperLip.x, f.upperLip.y, 0, jawOpen * 0.03 * sc, 0.10, 0.03, d, false);
    }

    // Mouth close
    const mouthClose = g('mouthClose');
    if (mouthClose > 0.01) {
      this._displace(f.mouth.x, f.mouth.y, 0, mouthClose * 0.03 * sc, 0.10, 0.04, d, false);
    }

    // Smile — mouth corners move UP and OUT
    const smileL = g('mouthSmileLeft');
    const smileR = g('mouthSmileRight');
    if (smileL > 0.01) {
      this._displace(f.leftMouthCorner.x, f.leftMouthCorner.y,
        -smileL * 0.04 * sc, smileL * 0.06 * sc, 0.06, 0.04, d, false);
    }
    if (smileR > 0.01) {
      this._displace(f.rightMouthCorner.x, f.rightMouthCorner.y,
        smileR * 0.04 * sc, smileR * 0.06 * sc, 0.06, 0.04, d, false);
    }

    // Frown — mouth corners move DOWN
    const frownL = g('mouthFrownLeft');
    const frownR = g('mouthFrownRight');
    if (frownL > 0.01) {
      this._displace(f.leftMouthCorner.x, f.leftMouthCorner.y,
        0, -frownL * 0.04 * sc, 0.05, 0.03, d, false);
    }
    if (frownR > 0.01) {
      this._displace(f.rightMouthCorner.x, f.rightMouthCorner.y,
        0, -frownR * 0.04 * sc, 0.05, 0.03, d, false);
    }

    // Pucker — mouth sides move INWARD
    const pucker = g('mouthPucker');
    if (pucker > 0.01) {
      this._displace(f.leftMouthCorner.x, f.leftMouthCorner.y,
        pucker * 0.03 * sc, 0, 0.05, 0.04, d, false);
      this._displace(f.rightMouthCorner.x, f.rightMouthCorner.y,
        -pucker * 0.03 * sc, 0, 0.05, 0.04, d, false);
    }

    // Funnel
    const funnel = g('mouthFunnel');
    if (funnel > 0.01) {
      this._displace(f.leftMouthCorner.x, f.leftMouthCorner.y,
        funnel * 0.02 * sc, 0, 0.04, 0.04, d, false);
      this._displace(f.rightMouthCorner.x, f.rightMouthCorner.y,
        -funnel * 0.02 * sc, 0, 0.04, 0.04, d, false);
    }

    // Stretch — mouth sides move OUTWARD
    const stretchL = g('mouthStretchLeft');
    const stretchR = g('mouthStretchRight');
    if (stretchL > 0.01) {
      this._displace(f.leftMouthCorner.x, f.leftMouthCorner.y,
        -stretchL * 0.04 * sc, 0, 0.05, 0.03, d, false);
    }
    if (stretchR > 0.01) {
      this._displace(f.rightMouthCorner.x, f.rightMouthCorner.y,
        stretchR * 0.04 * sc, 0, 0.05, 0.03, d, false);
    }

    // ====================================================================
    // Eyes — blink: upper eyelid moves DOWN (-y)
    // ====================================================================

    const blinkL = g('eyeBlinkLeft');
    const blinkR = g('eyeBlinkRight');
    if (blinkL > 0.01) {
      this._displace(f.leftEye.x, f.leftEye.y,
        0, -blinkL * 0.07 * sc, 0.06, 0.03, d, hasGlasses);
    }
    if (blinkR > 0.01) {
      this._displace(f.rightEye.x, f.rightEye.y,
        0, -blinkR * 0.07 * sc, 0.06, 0.03, d, hasGlasses);
    }

    // Eye wide: upper eyelid moves UP (+y)
    const wideL = g('eyeWideLeft');
    const wideR = g('eyeWideRight');
    if (wideL > 0.01) {
      this._displace(f.leftEye.x, f.leftEye.y - f.faceHeight * 0.02,
        0, wideL * 0.03 * sc, 0.05, 0.03, d, hasGlasses);
    }
    if (wideR > 0.01) {
      this._displace(f.rightEye.x, f.rightEye.y - f.faceHeight * 0.02,
        0, wideR * 0.03 * sc, 0.05, 0.03, d, hasGlasses);
    }

    // Eye squint: lower eyelid moves UP (+y)
    const squintL = g('eyeSquintLeft');
    const squintR = g('eyeSquintRight');
    if (squintL > 0.01) {
      this._displace(f.leftEye.x, f.leftEye.y + f.faceHeight * 0.02,
        0, squintL * 0.02 * sc, 0.05, 0.02, d, hasGlasses);
    }
    if (squintR > 0.01) {
      this._displace(f.rightEye.x, f.rightEye.y + f.faceHeight * 0.02,
        0, squintR * 0.02 * sc, 0.05, 0.02, d, hasGlasses);
    }

    // ====================================================================
    // Eyebrows: raise = UP (+y), furrow = DOWN (-y)
    // ====================================================================

    const browInnerUp = g('browInnerUp');
    if (browInnerUp > 0.01) {
      this._displace(f.leftBrow.x, f.leftBrow.y,
        0, browInnerUp * 0.06 * sc, 0.06, 0.03, d, hasGlasses);
      this._displace(f.rightBrow.x, f.rightBrow.y,
        0, browInnerUp * 0.06 * sc, 0.06, 0.03, d, hasGlasses);
    }

    const browDownL = g('browDownLeft');
    const browDownR = g('browDownRight');
    if (browDownL > 0.01) {
      this._displace(f.leftBrow.x, f.leftBrow.y,
        0, -browDownL * 0.03 * sc, 0.05, 0.025, d, hasGlasses);
    }
    if (browDownR > 0.01) {
      this._displace(f.rightBrow.x, f.rightBrow.y,
        0, -browDownR * 0.03 * sc, 0.05, 0.025, d, hasGlasses);
    }

    const browOuterUpL = g('browOuterUpLeft');
    const browOuterUpR = g('browOuterUpRight');
    if (browOuterUpL > 0.01) {
      this._displace(f.leftBrowOuter.x, f.leftBrowOuter.y,
        0, browOuterUpL * 0.04 * sc, 0.05, 0.025, d, hasGlasses);
    }
    if (browOuterUpR > 0.01) {
      this._displace(f.rightBrowOuter.x, f.rightBrowOuter.y,
        0, browOuterUpR * 0.04 * sc, 0.05, 0.025, d, hasGlasses);
    }

    // ====================================================================
    // Cheeks & nose
    // ====================================================================

    const cheekPuff = g('cheekPuff');
    if (cheekPuff > 0.01) {
      this._displace(f.leftCheek.x, f.leftCheek.y,
        -cheekPuff * 0.04 * sc, 0, 0.06, 0.06, d, false);
      this._displace(f.rightCheek.x, f.rightCheek.y,
        cheekPuff * 0.04 * sc, 0, 0.06, 0.06, d, false);
    }

    const noseSneerL = g('noseSneerLeft');
    const noseSneerR = g('noseSneerRight');
    if (noseSneerL > 0.01) {
      this._displace(f.leftNose.x, f.leftNose.y,
        -noseSneerL * 0.01 * sc, noseSneerL * 0.015 * sc, 0.04, 0.03, d, false);
    }
    if (noseSneerR > 0.01) {
      this._displace(f.rightNose.x, f.rightNose.y,
        noseSneerR * 0.01 * sc, noseSneerR * 0.015 * sc, 0.04, 0.03, d, false);
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
   * @param {number} cx - Control X in texture coords (0-1)
   * @param {number} cy - Control Y in texture coords (0-1)
   * @param {number} dx - Displacement X in NDC (+right)
   * @param {number} dy - Displacement Y in NDC (+up, -down)
   * @param {number} sigmaX - Gaussian spread X
   * @param {number} sigmaY - Gaussian spread Y
   * @param {Float32Array} d - Output
   * @param {boolean} rigid - Glasses zone protection
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

      if (rigid && this.hasGlasses && this._inGlassesZone(vx, vy)) {
        weight *= 0.05;
      }

      if (weight < 0.001) continue;

      d[i * 2] += dx * weight;
      d[i * 2 + 1] += dy * weight;
    }
  }

  /**
   * Check if point is in glasses zone (dynamic based on face detection).
   * @private
   */
  _inGlassesZone(x, y) {
    const f = this._face;
    return y >= f.glassesTop && y <= f.glassesBottom &&
           x >= f.glassesLeft && x <= f.glassesRight;
  }

  /**
   * Apply head pose as global vertex transform.
   * @private
   */
  _applyHeadPose(pose, d) {
    const yaw = pose.yaw || 0;
    const pitch = pose.pitch || 0;
    const roll = pose.roll || 0;

    // ★ Increased scales for visible movement
    const yawScale = 0.006;   // degrees → NDC
    const pitchScale = 0.005;

    const rollRad = roll * Math.PI / 180;
    const cosR = Math.cos(rollRad);
    const sinR = Math.sin(rollRad);

    const n = this._vertexCount;

    for (let i = 0; i < n; i++) {
      const vx = this._vertexNorm[i * 2] - 0.5;
      const vy = this._vertexNorm[i * 2 + 1] - 0.5;

      // Yaw: shift entire face horizontally
      const yawDisp = yaw * yawScale;

      // Pitch: shift vertically (+pitch = look up = face shifts up = +NDC)
      const pitchDisp = pitch * pitchScale;

      // Roll: rotation around center
      const rx = vx * cosR - vy * sinR - vx;
      const ry = vx * sinR + vy * cosR - vy;

      d[i * 2] += yawDisp + rx;
      // pitch up → face moves up → +y in NDC
      d[i * 2 + 1] += pitchDisp + ry;
    }
  }

  /**
   * Get mouth center in texture coords for fragment shader.
   * @param {Object<string, number>} bs
   * @returns {{x: number, y: number}}
   */
  getMouthCenter(bs) {
    const jawOpen = bs.jawOpen || 0;
    return {
      x: this._face.mouth.x,
      y: this._face.mouth.y + jawOpen * 0.03,
    };
  }
}

window.BlendShapeDriver = BlendShapeDriver;
