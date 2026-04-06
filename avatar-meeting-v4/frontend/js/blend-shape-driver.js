/**
 * @fileoverview BlendShape → Mesh Vertex Displacement converter.
 *
 * ★ v4.2 fixes:
 *   - Larger Gaussian sigmas so effects work even with imprecise face detection
 *   - updateFromLandmarks() updates control points from MediaPipe 478 landmarks
 *   - Console logging of detected face positions for debugging
 *   - Removed mouth interior shader dependency (pure mesh warp)
 */

class BlendShapeDriver {
  constructor(cols = 20, rows = 24, imageWidth = 640, imageHeight = 480) {
    /** @private */ this._cols = cols;
    /** @private */ this._rows = rows;
    /** @private */ this._vCols = cols + 1;
    /** @private */ this._vRows = rows + 1;
    /** @private */ this._vertexCount = this._vCols * this._vRows;
    /** @private */ this._imgW = imageWidth;
    /** @private */ this._imgH = imageHeight;

    this._displacements = new Float32Array(this._vertexCount * 2);

    // Pre-compute vertex normalized positions (0-1 in texture space)
    this._vertexNorm = new Float32Array(this._vertexCount * 2);
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        const idx = (r * this._vCols + c) * 2;
        this._vertexNorm[idx] = c / cols;
        this._vertexNorm[idx + 1] = r / rows;
      }
    }

    /** @type {boolean} */ this.hasGlasses = false;
    /** @private */ this._face = this._defaultFacePositions();
    /** @private */ this._landmarksApplied = false;
  }

  // ==========================================================================
  // Face detection
  // ==========================================================================

  async detectFace(image) {
    // Try FaceDetector API
    if ('FaceDetector' in window) {
      try {
        const detector = new FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
        const faces = await detector.detect(image);
        if (faces.length > 0) {
          const face = faces[0];
          const w = image.naturalWidth || image.width;
          const h = image.naturalHeight || image.height;
          const box = face.boundingBox;
          const fx = box.x / w, fy = box.y / h;
          const fw = box.width / w, fh = box.height / h;

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
          this._logFacePositions('FaceDetector');
          return true;
        }
      } catch (e) {
        console.warn('[BlendShapeDriver] FaceDetector failed:', e.message);
      }
    }

    // Luminance fallback
    try {
      if (this._detectByLuminance(image)) return true;
    } catch (e) { /* ignore */ }

    console.log('[BlendShapeDriver] No face detected, using defaults');
    this._face = this._defaultFacePositions();
    this._logFacePositions('default');
    return false;
  }

  /**
   * ★ Update control points from MediaPipe 478 face landmarks.
   * Called when camera starts and MediaPipe provides landmarks on user's face,
   * or when we run MediaPipe on the avatar image.
   * @param {Array<{x: number, y: number, z: number}>} landmarks - 478 points (0-1)
   */
  updateFromLandmarks(landmarks) {
    if (!landmarks || landmarks.length < 468) return;

    const f = this._face;

    // Key MediaPipe landmark indices:
    // Left eye: 33 (outer), 133 (inner), 159 (top), 145 (bottom), 468 (center iris)
    // Right eye: 362 (outer), 263 (inner), 386 (top), 374 (bottom), 473 (center iris)
    // Upper lip top center: 13
    // Lower lip bottom center: 14
    // Mouth left corner: 61
    // Mouth right corner: 291
    // Nose tip: 1
    // Left eyebrow: 70 (inner), 105 (mid), 107 (outer)
    // Right eyebrow: 300 (inner), 334 (mid), 336 (outer)
    // Chin: 152
    // Forehead: 10

    const lm = (i) => landmarks[i];

    // Eyes
    f.leftEye = { x: (lm(33).x + lm(133).x) / 2, y: (lm(159).y + lm(145).y) / 2 };
    f.rightEye = { x: (lm(362).x + lm(263).x) / 2, y: (lm(386).y + lm(374).y) / 2 };

    // Mouth
    f.mouth = { x: (lm(61).x + lm(291).x) / 2, y: (lm(13).y + lm(14).y) / 2 };
    f.upperLip = { x: lm(13).x, y: lm(13).y };
    f.lowerLip = { x: lm(14).x, y: lm(14).y };
    f.leftMouthCorner = { x: lm(61).x, y: lm(61).y };
    f.rightMouthCorner = { x: lm(291).x, y: lm(291).y };

    // Nose
    f.nose = { x: lm(1).x, y: lm(1).y };
    f.leftNose = { x: lm(129).x, y: lm(129).y };
    f.rightNose = { x: lm(358).x, y: lm(358).y };

    // Eyebrows
    f.leftBrow = { x: lm(70).x, y: lm(70).y };
    f.rightBrow = { x: lm(300).x, y: lm(300).y };
    f.leftBrowOuter = { x: lm(107).x, y: lm(107).y };
    f.rightBrowOuter = { x: lm(336).x, y: lm(336).y };

    // Jaw & chin
    f.jaw = { x: lm(152).x, y: lm(152).y };

    // Face dimensions
    const chin = lm(152);
    const forehead = lm(10);
    const leftCheekPt = lm(234);
    const rightCheekPt = lm(454);
    f.faceHeight = Math.abs(chin.y - forehead.y);
    f.faceWidth = Math.abs(rightCheekPt.x - leftCheekPt.x);
    f.center = { x: (leftCheekPt.x + rightCheekPt.x) / 2, y: (forehead.y + chin.y) / 2 };

    // Cheeks
    f.leftCheek = { x: leftCheekPt.x, y: (f.nose.y + f.mouth.y) / 2 };
    f.rightCheek = { x: rightCheekPt.x, y: (f.nose.y + f.mouth.y) / 2 };

    // Glasses zone (around eyes)
    f.glassesTop = Math.min(f.leftEye.y, f.rightEye.y) - f.faceHeight * 0.05;
    f.glassesBottom = Math.max(f.leftEye.y, f.rightEye.y) + f.faceHeight * 0.10;
    f.glassesLeft = f.leftBrowOuter.x - f.faceWidth * 0.05;
    f.glassesRight = f.rightBrowOuter.x + f.faceWidth * 0.05;

    // Scale
    f.scale = f.faceHeight * 0.5;

    this._landmarksApplied = true;
    this._logFacePositions('MediaPipe landmarks');
  }

  /** @private */
  _logFacePositions(source) {
    const f = this._face;
    console.log(`[BlendShapeDriver] Face from ${source}:`);
    console.log(`  leftEye=(${f.leftEye.x.toFixed(3)},${f.leftEye.y.toFixed(3)}) rightEye=(${f.rightEye.x.toFixed(3)},${f.rightEye.y.toFixed(3)})`);
    console.log(`  mouth=(${f.mouth.x.toFixed(3)},${f.mouth.y.toFixed(3)}) jaw=(${f.jaw.x.toFixed(3)},${f.jaw.y.toFixed(3)})`);
    console.log(`  faceSize=(${f.faceWidth.toFixed(3)},${f.faceHeight.toFixed(3)}) scale=${f.scale.toFixed(3)}`);
  }

  /** @private */
  _setFaceFromBBox(fx, fy, fw, fh, landmarks) {
    const cx = fx + fw * 0.5;
    const f = this._face;

    const eyeY = landmarks.eye ? landmarks.eye.y : fy + fh * 0.35;
    f.leftEye = { x: cx - fw * 0.18, y: eyeY };
    f.rightEye = { x: cx + fw * 0.18, y: eyeY };
    f.mouth = landmarks.mouth || { x: cx, y: fy + fh * 0.72 };
    f.nose = landmarks.nose || { x: cx, y: fy + fh * 0.55 };
    f.center = { x: cx, y: fy + fh * 0.5 };
    f.faceWidth = fw;
    f.faceHeight = fh;

    f.leftBrow = { x: f.leftEye.x, y: f.leftEye.y - fh * 0.08 };
    f.rightBrow = { x: f.rightEye.x, y: f.rightEye.y - fh * 0.08 };
    f.leftBrowOuter = { x: f.leftEye.x - fw * 0.12, y: f.leftEye.y - fh * 0.08 };
    f.rightBrowOuter = { x: f.rightEye.x + fw * 0.12, y: f.rightEye.y - fh * 0.08 };
    f.jaw = { x: cx, y: f.mouth.y + fh * 0.12 };
    f.upperLip = { x: cx, y: f.mouth.y - fh * 0.03 };
    f.lowerLip = { x: cx, y: f.mouth.y + fh * 0.02 };
    f.leftMouthCorner = { x: cx - fw * 0.15, y: f.mouth.y };
    f.rightMouthCorner = { x: cx + fw * 0.15, y: f.mouth.y };
    f.leftCheek = { x: cx - fw * 0.28, y: f.nose.y + fh * 0.05 };
    f.rightCheek = { x: cx + fw * 0.28, y: f.nose.y + fh * 0.05 };
    f.leftNose = { x: cx - fw * 0.06, y: f.nose.y };
    f.rightNose = { x: cx + fw * 0.06, y: f.nose.y };
    f.glassesTop = f.leftEye.y - fh * 0.05;
    f.glassesBottom = f.leftEye.y + fh * 0.12;
    f.glassesLeft = f.leftEye.x - fw * 0.15;
    f.glassesRight = f.rightEye.x + fw * 0.15;
    f.scale = fh * 0.5;
  }

  /** @private */
  _detectByLuminance(image) {
    const oc = document.createElement('canvas');
    const sz = 100;
    const w = image.naturalWidth || image.width;
    const h = image.naturalHeight || image.height;
    const scale = sz / Math.max(w, h);
    oc.width = Math.round(w * scale);
    oc.height = Math.round(h * scale);
    const ctx = oc.getContext('2d');
    ctx.drawImage(image, 0, 0, oc.width, oc.height);
    const data = ctx.getImageData(0, 0, oc.width, oc.height).data;

    let sumX = 0, sumY = 0, count = 0;
    for (let y = 0; y < oc.height; y++) {
      for (let x = 0; x < oc.width; x++) {
        const i = (y * oc.width + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        if (r > 95 && g > 40 && b > 20 && r > g && r > b &&
            (r - g) > 15 && (r - Math.min(g, b)) > 15) {
          sumX += x; sumY += y; count++;
        }
      }
    }
    if (count < 50) return false;

    const cx = (sumX / count) / oc.width;
    const cy = (sumY / count) / oc.height;
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
    const fw = Math.sqrt(varX / count) * 4;
    const fh = Math.sqrt(varY / count) * 4;
    this._setFaceFromBBox(cx - fw / 2, cy - fh / 2, fw, fh, {});
    this._logFacePositions('luminance');
    return true;
  }

  /** @private */
  _defaultFacePositions() {
    const f = {};
    f.faceWidth = 0.50; f.faceHeight = 0.65;
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
    f.glassesTop = 0.33; f.glassesBottom = 0.45;
    f.glassesLeft = 0.25; f.glassesRight = 0.75;
    f.scale = 0.325;
    return f;
  }

  // ==========================================================================
  // Main computation
  // ==========================================================================

  computeDisplacements(bs, pose, hasGlasses) {
    const d = this._displacements;
    d.fill(0);
    this.hasGlasses = hasGlasses;
    const f = this._face;
    const sc = f.scale;
    const g = (name) => bs[name] || 0;

    // NDC: +y = UP, -y = DOWN, +x = RIGHT, -x = LEFT
    // ★ v4.3: Displacement values in NDC space (range -2 to +2).
    //   sc is in tex coords (0-1), multiply by 2 for NDC conversion.
    const ndc = sc * 2.0; // convert tex-space scale to NDC-space scale

    // ==== Mouth ====
    const jawOpen = g('jawOpen');
    if (jawOpen > 0.01) {
      // Lower lip DOWN (negative Y in NDC)
      this._displace(f.lowerLip.x, f.lowerLip.y, 0, -jawOpen * 0.30 * ndc, 0.15, 0.10, d, false);
      // Jaw/chin DOWN
      this._displace(f.jaw.x, f.jaw.y, 0, -jawOpen * 0.22 * ndc, 0.20, 0.12, d, false);
      // Upper lip UP slightly (positive Y in NDC)
      this._displace(f.upperLip.x, f.upperLip.y, 0, jawOpen * 0.06 * ndc, 0.12, 0.05, d, false);
    }

    const mouthClose = g('mouthClose');
    if (mouthClose > 0.01) {
      this._displace(f.mouth.x, f.mouth.y, 0, mouthClose * 0.05 * ndc, 0.12, 0.06, d, false);
    }

    // Smile — corners pull outward and UP
    const smileL = g('mouthSmileLeft'), smileR = g('mouthSmileRight');
    if (smileL > 0.01) {
      this._displace(f.leftMouthCorner.x, f.leftMouthCorner.y,
        -smileL * 0.08 * ndc, smileL * 0.10 * ndc, 0.10, 0.08, d, false);
    }
    if (smileR > 0.01) {
      this._displace(f.rightMouthCorner.x, f.rightMouthCorner.y,
        smileR * 0.08 * ndc, smileR * 0.10 * ndc, 0.10, 0.08, d, false);
    }

    // Frown — corners pull DOWN
    const frownL = g('mouthFrownLeft'), frownR = g('mouthFrownRight');
    if (frownL > 0.01) this._displace(f.leftMouthCorner.x, f.leftMouthCorner.y, 0, -frownL*0.08*ndc, 0.08, 0.06, d, false);
    if (frownR > 0.01) this._displace(f.rightMouthCorner.x, f.rightMouthCorner.y, 0, -frownR*0.08*ndc, 0.08, 0.06, d, false);

    // Pucker — corners move inward
    const pucker = g('mouthPucker');
    if (pucker > 0.01) {
      this._displace(f.leftMouthCorner.x, f.leftMouthCorner.y, pucker*0.06*ndc, 0, 0.08, 0.06, d, false);
      this._displace(f.rightMouthCorner.x, f.rightMouthCorner.y, -pucker*0.06*ndc, 0, 0.08, 0.06, d, false);
    }

    // Stretch — corners pull outward
    const stretchL = g('mouthStretchLeft'), stretchR = g('mouthStretchRight');
    if (stretchL > 0.01) this._displace(f.leftMouthCorner.x, f.leftMouthCorner.y, -stretchL*0.06*ndc, 0, 0.08, 0.05, d, false);
    if (stretchR > 0.01) this._displace(f.rightMouthCorner.x, f.rightMouthCorner.y, stretchR*0.06*ndc, 0, 0.08, 0.05, d, false);

    // ==== Eyes — blink (eyelid contracts DOWN = negative Y in NDC) ====
    const blinkL = g('eyeBlinkLeft'), blinkR = g('eyeBlinkRight');
    if (blinkL > 0.01) {
      // Upper eyelid area moves DOWN
      this._displace(f.leftEye.x, f.leftEye.y - f.faceHeight*0.02, 0, -blinkL * 0.14 * ndc, 0.10, 0.05, d, hasGlasses);
      // Lower eyelid area moves UP slightly
      this._displace(f.leftEye.x, f.leftEye.y + f.faceHeight*0.02, 0, blinkL * 0.04 * ndc, 0.10, 0.03, d, hasGlasses);
    }
    if (blinkR > 0.01) {
      this._displace(f.rightEye.x, f.rightEye.y - f.faceHeight*0.02, 0, -blinkR * 0.14 * ndc, 0.10, 0.05, d, hasGlasses);
      this._displace(f.rightEye.x, f.rightEye.y + f.faceHeight*0.02, 0, blinkR * 0.04 * ndc, 0.10, 0.03, d, hasGlasses);
    }

    // Eye wide — upper lid UP
    const wideL = g('eyeWideLeft'), wideR = g('eyeWideRight');
    if (wideL > 0.01) this._displace(f.leftEye.x, f.leftEye.y - f.faceHeight*0.02, 0, wideL*0.06*ndc, 0.08, 0.04, d, hasGlasses);
    if (wideR > 0.01) this._displace(f.rightEye.x, f.rightEye.y - f.faceHeight*0.02, 0, wideR*0.06*ndc, 0.08, 0.04, d, hasGlasses);

    // Eye squint — lower lid UP
    const squintL = g('eyeSquintLeft'), squintR = g('eyeSquintRight');
    if (squintL > 0.01) this._displace(f.leftEye.x, f.leftEye.y + f.faceHeight*0.02, 0, squintL*0.04*ndc, 0.07, 0.03, d, hasGlasses);
    if (squintR > 0.01) this._displace(f.rightEye.x, f.rightEye.y + f.faceHeight*0.02, 0, squintR*0.04*ndc, 0.07, 0.03, d, hasGlasses);

    // ==== Eyebrows ====
    const browInnerUp = g('browInnerUp');
    if (browInnerUp > 0.01) {
      this._displace(f.leftBrow.x, f.leftBrow.y, 0, browInnerUp*0.10*ndc, 0.10, 0.05, d, hasGlasses);
      this._displace(f.rightBrow.x, f.rightBrow.y, 0, browInnerUp*0.10*ndc, 0.10, 0.05, d, hasGlasses);
    }
    const browDownL = g('browDownLeft'), browDownR = g('browDownRight');
    if (browDownL > 0.01) this._displace(f.leftBrow.x, f.leftBrow.y, 0, -browDownL*0.06*ndc, 0.08, 0.04, d, hasGlasses);
    if (browDownR > 0.01) this._displace(f.rightBrow.x, f.rightBrow.y, 0, -browDownR*0.06*ndc, 0.08, 0.04, d, hasGlasses);
    const browOuterUpL = g('browOuterUpLeft'), browOuterUpR = g('browOuterUpRight');
    if (browOuterUpL > 0.01) this._displace(f.leftBrowOuter.x, f.leftBrowOuter.y, 0, browOuterUpL*0.07*ndc, 0.07, 0.04, d, hasGlasses);
    if (browOuterUpR > 0.01) this._displace(f.rightBrowOuter.x, f.rightBrowOuter.y, 0, browOuterUpR*0.07*ndc, 0.07, 0.04, d, hasGlasses);

    // ==== Cheeks & nose ====
    const cheekPuff = g('cheekPuff');
    if (cheekPuff > 0.01) {
      this._displace(f.leftCheek.x, f.leftCheek.y, -cheekPuff*0.08*ndc, 0, 0.10, 0.10, d, false);
      this._displace(f.rightCheek.x, f.rightCheek.y, cheekPuff*0.08*ndc, 0, 0.10, 0.10, d, false);
    }

    // ==== Head pose ====
    if (pose) this._applyHeadPose(pose, d);

    return d;
  }

  // ==========================================================================
  // Private
  // ==========================================================================

  _displace(cx, cy, dx, dy, sigmaX, sigmaY, d, rigid) {
    const invSx2 = 1.0 / (sigmaX * sigmaX);
    const invSy2 = 1.0 / (sigmaY * sigmaY);
    const vn = this._vertexNorm;
    const n = this._vertexCount;

    for (let i = 0; i < n; i++) {
      const vx = vn[i * 2], vy = vn[i * 2 + 1];
      const ddx = vx - cx, ddy = vy - cy;
      let weight = Math.exp(-(ddx * ddx * invSx2 + ddy * ddy * invSy2));

      if (rigid && this.hasGlasses && this._inGlassesZone(vx, vy)) weight *= 0.05;
      if (weight < 0.001) continue;

      d[i * 2] += dx * weight;
      d[i * 2 + 1] += dy * weight;
    }
  }

  _inGlassesZone(x, y) {
    const f = this._face;
    return y >= f.glassesTop && y <= f.glassesBottom && x >= f.glassesLeft && x <= f.glassesRight;
  }

  _applyHeadPose(pose, d) {
    const yaw = pose.yaw || 0;
    const pitch = pose.pitch || 0;
    const roll = pose.roll || 0;

    // ★ v4.3: NDC-space scales. 1 degree of yaw → ~0.015 NDC shift (visible!)
    const yawScale = 0.015;
    const pitchScale = 0.012;

    const rollRad = roll * Math.PI / 180;
    const cosR = Math.cos(rollRad);
    const sinR = Math.sin(rollRad);

    const n = this._vertexCount;
    for (let i = 0; i < n; i++) {
      const vx = this._vertexNorm[i * 2] - 0.5;
      const vy = this._vertexNorm[i * 2 + 1] - 0.5;
      const rx = vx * cosR - vy * sinR - vx;
      const ry = vx * sinR + vy * cosR - vy;

      d[i * 2] += yaw * yawScale + rx;
      d[i * 2 + 1] += pitch * pitchScale + ry;
    }
  }

  getMouthCenter(bs) {
    return { x: this._face.mouth.x, y: this._face.mouth.y };
  }
}

window.BlendShapeDriver = BlendShapeDriver;
