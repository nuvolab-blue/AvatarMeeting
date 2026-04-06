/**
 * @fileoverview Region-based face deformation engine with glasses protection.
 *
 * VFX technique: divides face into 9 regions with individual rigidity,
 * preventing glasses frame distortion while allowing natural expressions.
 *
 * Key innovation:
 *  - Glasses detected → eye regions use skin-color overlay blink (no mesh warp)
 *  - Mouth is always free-deform (rigidity=0)
 *  - Nose bridge is always rigid (rigidity≈1)
 *  - Perlin Noise fBm drives idle micro-expressions
 */

import PerlinNoise from './perlin-noise.js';

/** @typedef {{x:number, y:number, w:number, h:number, rigidity:number}} Region */

/**
 * Default region definitions (normalized 0-1 coordinates).
 * @type {Object<string, {x:number,y:number,w:number,h:number,rigBase:number,rigGlasses:number}>}
 */
const REGIONS = {
  mouth:      { x: 0.34, y: 0.61, w: 0.32, h: 0.15, rigBase: 0.0,  rigGlasses: 0.0  },
  leftEye:    { x: 0.31, y: 0.37, w: 0.15, h: 0.09, rigBase: 0.3,  rigGlasses: 0.88 },
  rightEye:   { x: 0.54, y: 0.37, w: 0.15, h: 0.09, rigBase: 0.3,  rigGlasses: 0.88 },
  leftBrow:   { x: 0.29, y: 0.29, w: 0.19, h: 0.07, rigBase: 0.1,  rigGlasses: 0.55 },
  rightBrow:  { x: 0.52, y: 0.29, w: 0.19, h: 0.07, rigBase: 0.1,  rigGlasses: 0.55 },
  noseBridge: { x: 0.44, y: 0.35, w: 0.12, h: 0.17, rigBase: 0.95, rigGlasses: 1.0  },
  jaw:        { x: 0.27, y: 0.56, w: 0.46, h: 0.22, rigBase: 0.2,  rigGlasses: 0.2  },
  leftCheek:  { x: 0.24, y: 0.43, w: 0.13, h: 0.19, rigBase: 0.2,  rigGlasses: 0.2  },
  rightCheek: { x: 0.63, y: 0.43, w: 0.13, h: 0.19, rigBase: 0.2,  rigGlasses: 0.2  },
};

class FaceRegionDeformer {
  /**
   * @param {HTMLCanvasElement} canvas - Output canvas
   * @param {HTMLImageElement} sourceImage - Original face photo
   */
  constructor(canvas, sourceImage) {
    /** @private */ this._canvas = canvas;
    /** @private */ this._ctx = canvas.getContext('2d');
    /** @private */ this._sourceImage = sourceImage;
    /** @private */ this._srcCanvas = null;
    /** @private */ this._srcCtx = null;

    /** @private */ this._w = 0;
    /** @private */ this._h = 0;

    /** @private {Object<string, Region>} */
    this._regions = {};

    /** @private */ this._hasGlasses = false;
    /** @private */ this._skinColor = null;

    /** @private */ this._perlin = new PerlinNoise(42);
    /** @private */ this._time = 0;

    // Deformation parameters (set each frame)
    /** @private */
    this._deform = {
      jawOpen: 0, lipStretch: 0, lipPucker: 0, mouthWidth: 0, mouthCorner: 0,
      leftBrowRaise: 0, rightBrowRaise: 0, browFurrow: 0,
      leftEyeOpen: 1, rightEyeOpen: 1, eyeWiden: 0,
      yaw: 0, pitch: 0, roll: 0,
    };

    // Idle animation state
    /** @private */ this._blinkPhase = 0; // 0=wait, 1=closing, 2=hold, 3=opening
    /** @private */ this._blinkStart = 0;
    /** @private */ this._nextBlinkTime = 2000 + Math.random() * 3000;
    /** @private */ this._blinkValue = 1; // 1=open, 0=closed

    /** @type {{blink: boolean, breath: boolean, micro: boolean}} */
    this.settings = { blink: true, breath: true, micro: true };
  }

  /** @type {boolean} */
  get hasGlasses() { return this._hasGlasses; }
  set hasGlasses(v) {
    this._hasGlasses = v;
    this._applyRigidity();
  }

  // ==========================================================================
  // Initialization
  // ==========================================================================

  /** Initialize source canvas, detect glasses, build regions. */
  init() {
    const img = this._sourceImage;
    this._w = img.naturalWidth || img.width;
    this._h = img.naturalHeight || img.height;

    this._canvas.width = this._w;
    this._canvas.height = this._h;

    // Source canvas (immutable copy of the photo)
    this._srcCanvas = document.createElement('canvas');
    this._srcCanvas.width = this._w;
    this._srcCanvas.height = this._h;
    this._srcCtx = this._srcCanvas.getContext('2d');
    this._srcCtx.drawImage(img, 0, 0, this._w, this._h);

    // Build regions with pixel coordinates
    for (const [name, def] of Object.entries(REGIONS)) {
      this._regions[name] = {
        x: def.x * this._w,
        y: def.y * this._h,
        w: def.w * this._w,
        h: def.h * this._h,
        rigidity: def.rigBase,
      };
    }

    // Detect glasses
    this._hasGlasses = this._detectGlasses();
    if (this._hasGlasses) {
      this._applyRigidity();
      console.log('[FaceEngine] Glasses detected — enabling rigid protection');
    }

    // Cache skin color for blink overlay
    this._skinColor = this._getSkinColor();

    console.log('[FaceRegionDeformer] Init: %dx%d, glasses=%s',
      this._w, this._h, this._hasGlasses);
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Set deformation parameters for this frame.
   * @param {Object} params
   */
  setDeformation(params) {
    Object.assign(this._deform, params);
  }

  /**
   * Render deformed face to canvas.
   * @param {number} dt - Elapsed ms since last frame
   */
  render(dt) {
    this._time += dt;
    const ctx = this._ctx;
    const d = this._deform;

    // 1. Idle animation
    this._updateBlink(this._time);
    if (this.settings.breath) this._breath();
    if (this.settings.micro) this._micro();

    // Apply blink to eye open
    if (this.settings.blink) {
      d.leftEyeOpen = Math.min(d.leftEyeOpen, this._blinkValue);
      d.rightEyeOpen = Math.min(d.rightEyeOpen, this._blinkValue);
    }

    // 2. Clear and save
    ctx.clearRect(0, 0, this._w, this._h);
    ctx.save();

    // 3. Roll rotation
    const cx = this._w / 2;
    const cy = this._h / 2;
    const rollRad = (d.roll || 0) * Math.PI / 180;
    ctx.translate(cx, cy);
    ctx.rotate(rollRad);
    ctx.translate(-cx, -cy);

    // 4. Yaw/Pitch pseudo-3D
    const yawRad = (d.yaw || 0) * Math.PI / 180;
    const pitchRad = (d.pitch || 0) * Math.PI / 180;
    const scaleX = Math.cos(yawRad);
    const scaleY = Math.cos(pitchRad);
    const offsetX = Math.sin(yawRad) * this._w * 0.07;
    const offsetY = Math.sin(pitchRad) * this._h * 0.04;

    ctx.save();
    ctx.translate(cx + offsetX, cy + offsetY);
    ctx.scale(scaleX, scaleY);
    ctx.translate(-cx, -cy);

    // 5. Draw base image
    ctx.drawImage(this._srcCanvas, 0, 0, this._w, this._h);
    ctx.restore(); // undo yaw/pitch

    // 6. Region deformations (drawn on top with clipping)
    this._deformMouth(ctx);
    if (this._hasGlasses) {
      this._subtleBlink(ctx);
    } else {
      this._deformEyes(ctx);
    }
    this._deformBrows(ctx);
    this._deformCheeks(ctx);

    ctx.restore(); // undo roll
  }

  /**
   * Update regions from MediaPipe landmarks (optional).
   * @param {Array} landmarks - 468 FaceMesh landmarks
   */
  updateLandmarks(landmarks) {
    if (!landmarks || landmarks.length < 468) return;

    // Update mouth region from lip landmarks
    const mouthLandmarks = [13, 14, 78, 308, 61, 291];
    let minX = 1, maxX = 0, minY = 1, maxY = 0;
    for (const idx of mouthLandmarks) {
      const lm = landmarks[idx];
      if (lm.x < minX) minX = lm.x;
      if (lm.x > maxX) maxX = lm.x;
      if (lm.y < minY) minY = lm.y;
      if (lm.y > maxY) maxY = lm.y;
    }
    const pad = 0.03;
    this._regions.mouth = {
      x: (minX - pad) * this._w,
      y: (minY - pad) * this._h,
      w: (maxX - minX + pad * 2) * this._w,
      h: (maxY - minY + pad * 2) * this._h,
      rigidity: 0,
    };
  }

  // ==========================================================================
  // Private: Glasses detection
  // ==========================================================================

  /** @private @returns {boolean} */
  _detectGlasses() {
    try {
      const imgData = this._srcCtx.getImageData(0, 0, this._w, this._h);
      const data = imgData.data;

      // Bridge region: y ≈ 0.35-0.42, x: 0.28-0.72
      const y0 = Math.floor(this._h * 0.35);
      const y1 = Math.floor(this._h * 0.42);
      const x0 = Math.floor(this._w * 0.28);
      const x1 = Math.floor(this._w * 0.72);

      let edgeCount = 0;
      let totalPixels = 0;

      for (let y = y0; y < y1 - 1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * this._w + x) * 4;
          const iBelow = ((y + 1) * this._w + x) * 4;

          const lumHere = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
          const lumBelow = data[iBelow] * 0.299 + data[iBelow + 1] * 0.587 + data[iBelow + 2] * 0.114;

          if (Math.abs(lumHere - lumBelow) > 35) edgeCount++;
          totalPixels++;
        }
      }

      const edgeDensity = totalPixels > 0 ? edgeCount / totalPixels : 0;
      console.log('[FaceRegionDeformer] Edge density: %.3f', edgeDensity);
      return edgeDensity > 0.12;
    } catch (e) {
      console.warn('[FaceRegionDeformer] Glasses detection failed:', e);
      return false;
    }
  }

  /** @private */
  _applyRigidity() {
    for (const [name, def] of Object.entries(REGIONS)) {
      this._regions[name].rigidity = this._hasGlasses ? def.rigGlasses : def.rigBase;
    }
  }

  // ==========================================================================
  // Private: Skin color detection
  // ==========================================================================

  /** @private @returns {{r:number,g:number,b:number}} */
  _getSkinColor() {
    try {
      // Sample forehead area (y≈0.20-0.28, x: 0.40-0.60)
      const x0 = Math.floor(this._w * 0.40);
      const x1 = Math.floor(this._w * 0.60);
      const y0 = Math.floor(this._h * 0.20);
      const y1 = Math.floor(this._h * 0.28);

      const imgData = this._srcCtx.getImageData(x0, y0, x1 - x0, y1 - y0);
      const data = imgData.data;
      let r = 0, g = 0, b = 0, count = 0;

      for (let i = 0; i < data.length; i += 4) {
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        count++;
      }

      return count > 0
        ? { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) }
        : { r: 200, g: 170, b: 140 };
    } catch {
      return { r: 200, g: 170, b: 140 };
    }
  }

  // ==========================================================================
  // Private: Mouth deformation (rigidity=0, free deform)
  // ==========================================================================

  /** @private */
  _deformMouth(ctx) {
    const d = this._deform;
    const r = this._regions.mouth;
    if (!r) return;

    const jawOffset = d.jawOpen * r.h * 1.3;
    const stretchX = d.lipStretch * r.w * 0.35;
    const puckerX = d.lipPucker * r.w * -0.2;
    const cornerY = (d.mouthCorner || 0) * r.h * 0.4;

    // Skip if no deformation
    if (Math.abs(jawOffset) < 0.5 && Math.abs(stretchX) < 0.5 &&
        Math.abs(puckerX) < 0.5 && Math.abs(cornerY) < 0.5) return;

    const pad = 10;
    const mx = r.x - pad;
    const my = r.y - pad;
    const mw = r.w + pad * 2;
    const mh = r.h + pad * 2;
    const midY = r.y + r.h * 0.45; // Lip separation line

    ctx.save();

    // Clip to mouth region
    ctx.beginPath();
    this._roundRect(ctx, mx, my, mw, mh + jawOffset + pad, 8);
    ctx.clip();

    // Draw mouth cavity (dark interior) when jaw is open
    if (jawOffset > 2) {
      const cavCx = r.x + r.w / 2;
      const cavCy = midY + jawOffset * 0.3;
      const cavW = r.w * 0.5 + stretchX;
      const cavH = jawOffset * 0.7;

      const grad = ctx.createRadialGradient(cavCx, cavCy, 0, cavCx, cavCy, Math.max(cavW, cavH));
      grad.addColorStop(0, 'rgba(15, 8, 8, 0.92)');
      grad.addColorStop(0.5, 'rgba(35, 18, 12, 0.75)');
      grad.addColorStop(1, 'rgba(50, 25, 15, 0)');
      ctx.fillStyle = grad;
      ctx.fillRect(cavCx - cavW, cavCy - cavH, cavW * 2, cavH * 2);
    }

    // Upper lip (from source, slight upward shift on smile)
    const upperShift = -cornerY * 0.3;
    ctx.drawImage(
      this._srcCanvas,
      r.x, r.y, r.w, midY - r.y,    // source
      r.x - stretchX / 2 - puckerX / 2,
      r.y + upperShift,
      r.w + stretchX + puckerX,
      midY - r.y                      // dest
    );

    // Lower lip + jaw (shifted down)
    const lowerSrcH = r.y + r.h - midY;
    ctx.drawImage(
      this._srcCanvas,
      r.x, midY, r.w, lowerSrcH,     // source
      r.x - stretchX / 2 - puckerX / 2,
      midY + jawOffset + cornerY * 0.3,
      r.w + stretchX + puckerX,
      lowerSrcH                        // dest
    );

    // Feather edges
    this._feather(ctx, mx, my, mw, mh + jawOffset + pad, 7);

    ctx.restore();
  }

  // ==========================================================================
  // Private: Eye deformation (no glasses)
  // ==========================================================================

  /** @private */
  _deformEyes(ctx) {
    this._deformSingleEye(ctx, this._regions.leftEye, this._deform.leftEyeOpen);
    this._deformSingleEye(ctx, this._regions.rightEye, this._deform.rightEyeOpen);
  }

  /** @private */
  _deformSingleEye(ctx, r, eyeOpen) {
    if (!r || r.rigidity >= 0.95) return;
    const effectiveOpen = eyeOpen + (this._deform.eyeWiden || 0) * 0.2;
    const scaleY = 0.3 + Math.max(0, Math.min(1.2, effectiveOpen)) * 0.7;
    if (Math.abs(scaleY - 1) < 0.01) return;

    const eCx = r.x + r.w / 2;
    const eCy = r.y + r.h / 2;

    ctx.save();
    ctx.beginPath();
    ctx.ellipse(eCx, eCy, r.w / 2 + 2, r.h / 2 + 2, 0, 0, Math.PI * 2);
    ctx.clip();

    ctx.translate(eCx, eCy);
    ctx.scale(1, scaleY);
    ctx.translate(-eCx, -eCy);
    ctx.drawImage(this._srcCanvas, r.x - 2, r.y - 2, r.w + 4, r.h + 4,
                  r.x - 2, r.y - 2, r.w + 4, r.h + 4);

    ctx.restore();
  }

  // ==========================================================================
  // Private: Subtle blink (glasses-safe, overlay method)
  // ==========================================================================

  /** @private */
  _subtleBlink(ctx) {
    const sc = this._skinColor;
    this._subtleBlinkSingle(ctx, this._regions.leftEye, this._deform.leftEyeOpen, sc);
    this._subtleBlinkSingle(ctx, this._regions.rightEye, this._deform.rightEyeOpen, sc);
  }

  /** @private */
  _subtleBlinkSingle(ctx, r, eyeOpen, sc) {
    if (!r) return;
    const closedness = 1 - Math.max(0, Math.min(1, eyeOpen));
    if (closedness < 0.05) return;

    const eCx = r.x + r.w / 2;
    const eCy = r.y + r.h / 2;

    ctx.save();
    ctx.globalAlpha = closedness * 0.88;
    ctx.fillStyle = `rgb(${sc.r}, ${sc.g}, ${sc.b})`;
    ctx.beginPath();
    ctx.ellipse(eCx, eCy, r.w * 0.48, r.h * closedness, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ==========================================================================
  // Private: Brow deformation
  // ==========================================================================

  /** @private */
  _deformBrows(ctx) {
    this._deformSingleBrow(ctx, this._regions.leftBrow, this._deform.leftBrowRaise, -1);
    this._deformSingleBrow(ctx, this._regions.rightBrow, this._deform.rightBrowRaise, 1);
  }

  /** @private */
  _deformSingleBrow(ctx, r, raise, side) {
    if (!r) return;
    const effectiveRaise = raise * (1 - r.rigidity);
    const furrowOffset = (this._deform.browFurrow || 0) * r.h * 0.3;
    const offsetY = -(effectiveRaise * r.h * 1.6) + furrowOffset;
    const offsetX = (this._deform.browFurrow || 0) * r.w * 0.06 * side; // Inward shift

    if (Math.abs(offsetY) < 0.3 && Math.abs(offsetX) < 0.3) return;

    const pad = 5;
    ctx.save();
    ctx.beginPath();
    this._roundRect(ctx, r.x - pad, r.y - pad - Math.abs(offsetY), r.w + pad * 2, r.h + pad * 2 + Math.abs(offsetY) * 2, 4);
    ctx.clip();

    ctx.drawImage(
      this._srcCanvas,
      r.x, r.y, r.w, r.h,
      r.x + offsetX, r.y + offsetY, r.w, r.h
    );

    this._feather(ctx, r.x - pad, r.y - pad - Math.abs(offsetY), r.w + pad * 2, r.h + pad * 2 + Math.abs(offsetY) * 2, 5);
    ctx.restore();
  }

  // ==========================================================================
  // Private: Cheek deformation
  // ==========================================================================

  /** @private */
  _deformCheeks(ctx) {
    const mc = this._deform.mouthCorner || 0;
    if (Math.abs(mc) < 0.02) return;

    this._deformSingleCheek(ctx, this._regions.leftCheek, mc);
    this._deformSingleCheek(ctx, this._regions.rightCheek, mc);
  }

  /** @private */
  _deformSingleCheek(ctx, r, mouthCorner) {
    if (!r) return;
    const offsetY = -mouthCorner * r.h * 0.14;
    const scaleX = 1 + mouthCorner * 0.04;
    if (Math.abs(offsetY) < 0.3) return;

    const pad = 3;
    ctx.save();
    ctx.beginPath();
    this._roundRect(ctx, r.x - pad, r.y - pad, r.w + pad * 2, r.h + pad * 2, 4);
    ctx.clip();

    const cCx = r.x + r.w / 2;
    ctx.translate(cCx, 0);
    ctx.scale(scaleX, 1);
    ctx.translate(-cCx, 0);

    ctx.drawImage(
      this._srcCanvas,
      r.x, r.y, r.w, r.h,
      r.x, r.y + offsetY, r.w, r.h
    );

    this._feather(ctx, r.x - pad, r.y - pad, r.w + pad * 2, r.h + pad * 2, 5);
    ctx.restore();
  }

  // ==========================================================================
  // Private: Idle animations
  // ==========================================================================

  /** @private */
  _updateBlink(time) {
    if (!this.settings.blink) {
      this._blinkValue = 1;
      return;
    }

    const closeDur = 70;
    const holdDur = 40;
    const openDur = 110;

    if (this._blinkPhase === 0) {
      if (time >= this._nextBlinkTime) {
        this._blinkPhase = 1;
        this._blinkStart = time;
      }
    } else if (this._blinkPhase === 1) {
      // Closing
      const t = (time - this._blinkStart) / closeDur;
      this._blinkValue = Math.max(0, 1 - t);
      if (t >= 1) { this._blinkPhase = 2; this._blinkStart = time; }
    } else if (this._blinkPhase === 2) {
      // Hold closed
      this._blinkValue = 0;
      if (time - this._blinkStart >= holdDur) { this._blinkPhase = 3; this._blinkStart = time; }
    } else if (this._blinkPhase === 3) {
      // Opening
      const t = (time - this._blinkStart) / openDur;
      this._blinkValue = Math.min(1, t);
      if (t >= 1) {
        this._blinkValue = 1;
        this._blinkPhase = 0;
        const doubleBlink = Math.random() < 0.2;
        this._nextBlinkTime = time + (doubleBlink ? 180 : 2000 + Math.random() * 4000);
      }
    }
  }

  /** @private */
  _breath() {
    const t = this._time / 1000;
    const breathVal = Math.sin(t * 0.75 * Math.PI * 2) * 0.012;
    this._deform.jawOpen = Math.max(this._deform.jawOpen, breathVal);
  }

  /** @private */
  _micro() {
    const t = this._time / 1000;
    const p = this._perlin;

    this._deform.mouthCorner = (this._deform.mouthCorner || 0) + p.fbm(t * 0.28, 0) * 0.025;
    this._deform.leftBrowRaise = (this._deform.leftBrowRaise || 0) + p.fbm(t * 0.18, 10) * 0.018;
    this._deform.rightBrowRaise = (this._deform.rightBrowRaise || 0) + p.fbm(t * 0.18, 20) * 0.018;
    this._deform.yaw = (this._deform.yaw || 0) + p.fbm(t * 0.13, 30) * 1.2;
    this._deform.pitch = (this._deform.pitch || 0) + p.fbm(t * 0.10, 40) * 0.7;
    this._deform.roll = (this._deform.roll || 0) + p.fbm(t * 0.08, 50) * 0.4;
  }

  // ==========================================================================
  // Private: Utilities
  // ==========================================================================

  /**
   * Draw rounded rectangle path.
   * @private
   */
  _roundRect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  /**
   * Apply feathering (edge blending) using destination-in composite.
   * @private
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @param {number} size - Feather size in pixels
   */
  _feather(ctx, x, y, w, h, size) {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';

    // Top edge
    let g = ctx.createLinearGradient(x, y, x, y + size);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, size);

    // Bottom edge
    g = ctx.createLinearGradient(x, y + h - size, x, y + h);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y + h - size, w, size);

    // Left edge
    g = ctx.createLinearGradient(x, y, x + size, y);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,1)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, size, h);

    // Right edge
    g = ctx.createLinearGradient(x + w - size, y, x + w, y);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x + w - size, y, size, h);

    ctx.restore();
  }
}

export default FaceRegionDeformer;

if (typeof window !== 'undefined') {
  window.FaceRegionDeformer = FaceRegionDeformer;
}
