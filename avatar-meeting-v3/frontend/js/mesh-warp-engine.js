/**
 * @fileoverview Grid Mesh Warp rendering engine — VFX industry standard.
 *
 * Lays a COLS×ROWS triangle mesh over the face image. Each vertex is
 * displaced via Gaussian-weighted control points, producing seamless
 * deformation with no clipping artefacts.
 *
 * Key advantages over region-based deformation (v2):
 *  - No seams between regions
 *  - Mouth opens naturally via jaw + lip displacements
 *  - Glasses zone rigidity via per-vertex mask
 *  - Blink uses sampled skin pixels, not flat colour fill
 */

// ============================================================================
// Grid constants
// ============================================================================
const COLS = 20;
const ROWS = 24;

// ============================================================================
// Face feature control points (normalised 0-1)
// ============================================================================
const FEATURES = {
  mouthCenter: { x: 0.50, y: 0.68 },
  mouthLeft:   { x: 0.38, y: 0.67 },
  mouthRight:  { x: 0.62, y: 0.67 },
  upperLip:    { x: 0.50, y: 0.65 },
  lowerLip:    { x: 0.50, y: 0.72 },
  jawCenter:   { x: 0.50, y: 0.82 },
  leftEyeC:   { x: 0.37, y: 0.40 },
  rightEyeC:  { x: 0.63, y: 0.40 },
  leftBrowC:  { x: 0.35, y: 0.32 },
  rightBrowC: { x: 0.65, y: 0.32 },
  leftBrowIn: { x: 0.42, y: 0.33 },
  rightBrowIn:{ x: 0.58, y: 0.33 },
  noseTip:    { x: 0.50, y: 0.52 },
  leftCheek:  { x: 0.28, y: 0.55 },
  rightCheek: { x: 0.72, y: 0.55 },
};

// Glasses zone (no-displacement region)
const GLASSES_ZONE = { yMin: 0.34, yMax: 0.48, xMin: 0.25, xMax: 0.75 };

class MeshWarpEngine {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    /** @private */ this._canvas = canvas;
    /** @private */ this._ctx = canvas.getContext('2d');
    /** @private */ this._srcCanvas = null;
    /** @private */ this._srcCtx = null;
    /** @private */ this._w = 0;
    /** @private */ this._h = 0;

    // Grids: [row][col] = { x, y } in pixel coords
    /** @private */ this._srcGrid = null;
    /** @private */ this._dstGrid = null;

    // Mouth interior texture (pre-built)
    /** @private */ this._mouthTex = null;

    // Perlin noise for micro-expressions
    /** @private */ this._perlin = new PerlinNoise(42);
    /** @private */ this._time = 0;

    // Blink state
    /** @private */ this._blinkPhase = 0;
    /** @private */ this._blinkStart = 0;
    /** @private */ this._nextBlinkTime = 2000 + Math.random() * 3000;
    /** @private */ this._blinkValue = 1; // 1=open, 0=closed

    /** Deformation parameters (set each frame) */
    this.deform = {
      jawOpen: 0, lipStretch: 0, lipPucker: 0, mouthCorner: 0,
      leftBrowRaise: 0, rightBrowRaise: 0, browFurrow: 0,
      leftEyeOpen: 1, rightEyeOpen: 1, eyeWiden: 0,
      yaw: 0, pitch: 0, roll: 0,
    };

    /** @type {boolean} */
    this.hasGlasses = false;

    /** @type {{blink: boolean, breath: boolean, micro: boolean}} */
    this.settings = { blink: true, breath: true, micro: true };
  }

  // ==========================================================================
  // Initialisation
  // ==========================================================================

  /**
   * Initialise with source image.
   * @param {HTMLImageElement} image
   */
  init(image) {
    this._w = image.naturalWidth || image.width;
    this._h = image.naturalHeight || image.height;
    this._canvas.width = this._w;
    this._canvas.height = this._h;

    // Immutable copy of source
    this._srcCanvas = document.createElement('canvas');
    this._srcCanvas.width = this._w;
    this._srcCanvas.height = this._h;
    this._srcCtx = this._srcCanvas.getContext('2d');
    this._srcCtx.drawImage(image, 0, 0, this._w, this._h);

    // Build grids
    this._srcGrid = this._makeGrid();
    this._dstGrid = this._makeGrid();

    // Detect glasses
    this.hasGlasses = this._detectGlasses();
    if (this.hasGlasses) {
      console.log('[MeshWarp] Glasses detected — enabling rigid protection');
    }

    // Pre-build mouth interior texture
    this._mouthTex = this._buildMouthInterior();

    console.log(`[MeshWarp] Init: ${this._w}x${this._h}, grid=${COLS}x${ROWS} (${COLS * ROWS} cells), glasses=${this.hasGlasses}`);
  }

  // ==========================================================================
  // Render
  // ==========================================================================

  /**
   * Render one frame with current deformation parameters.
   * @param {number} dt - Elapsed ms since last frame
   */
  render(dt) {
    if (!this._srcGrid) return;
    const ctx = this._ctx;
    const d = this.deform;

    // 1. Advance time
    this._time += dt;

    // 2. Idle animations
    this._updateBlink(this._time);
    if (this.settings.breath) this._breath();
    if (this.settings.micro) this._micro();

    // 3. Apply blink
    if (this.settings.blink) {
      d.leftEyeOpen = Math.min(d.leftEyeOpen, this._blinkValue);
      d.rightEyeOpen = Math.min(d.rightEyeOpen, this._blinkValue);
    }

    // 4. Compute all vertex displacements
    this._applyDeformation();

    // 5. Clear
    ctx.clearRect(0, 0, this._w, this._h);

    // 6. Draw mesh (all cells)
    this._drawMesh(ctx);

    // 7. Mouth interior (under lips)
    if (d.jawOpen > 0.05) {
      this._drawMouthInterior(ctx);
    }

    // 8. Re-draw lip region on top of mouth interior
    if (d.jawOpen > 0.05) {
      this._drawMeshRegion(ctx, 0.30, 0.58, 0.70, 0.78);
    }

    // 9. Blink overlays
    this._drawBlink(ctx, d.leftEyeOpen, FEATURES.leftEyeC);
    this._drawBlink(ctx, d.rightEyeOpen, FEATURES.rightEyeC);
  }

  // ==========================================================================
  // Grid construction
  // ==========================================================================

  /** @private @returns {Array<Array<{x:number,y:number}>>} */
  _makeGrid() {
    const grid = [];
    for (let r = 0; r <= ROWS; r++) {
      const row = [];
      for (let c = 0; c <= COLS; c++) {
        row.push({ x: (c / COLS) * this._w, y: (r / ROWS) * this._h });
      }
      grid.push(row);
    }
    return grid;
  }

  // ==========================================================================
  // Gaussian displacement — core algorithm
  // ==========================================================================

  /**
   * Displace grid vertices around a control point using Gaussian falloff.
   * @private
   * @param {number} fx - Feature x (normalised 0-1)
   * @param {number} fy - Feature y (normalised 0-1)
   * @param {number} dx - Displacement x (normalised)
   * @param {number} dy - Displacement y (normalised)
   * @param {number} sigmaX - Gaussian spread x
   * @param {number} sigmaY - Gaussian spread y
   * @param {boolean} rigidMask - If true, skip glasses zone vertices
   */
  _displace(fx, fy, dx, dy, sigmaX, sigmaY, rigidMask) {
    const w = this._w;
    const h = this._h;
    const fpx = fx * w;
    const fpy = fy * h;
    const sx2 = (sigmaX * w) * (sigmaX * w);
    const sy2 = (sigmaY * h) * (sigmaY * h);
    const ddx = dx * w;
    const ddy = dy * h;

    const dst = this._dstGrid;
    for (let r = 0; r <= ROWS; r++) {
      for (let c = 0; c <= COLS; c++) {
        const v = dst[r][c];
        const sv = this._srcGrid[r][c];

        // Glasses zone check
        if (rigidMask && this.hasGlasses) {
          const ny = sv.y / h;
          const nx = sv.x / w;
          if (ny >= GLASSES_ZONE.yMin && ny <= GLASSES_ZONE.yMax &&
              nx >= GLASSES_ZONE.xMin && nx <= GLASSES_ZONE.xMax) {
            continue;
          }
        }

        const ex = sv.x - fpx;
        const ey = sv.y - fpy;
        const weight = Math.exp(-(ex * ex / sx2 + ey * ey / sy2));

        if (weight > 0.01) {
          v.x += ddx * weight;
          v.y += ddy * weight;
        }
      }
    }
  }

  // ==========================================================================
  // Deformation application
  // ==========================================================================

  /** @private */
  _applyDeformation() {
    const d = this.deform;
    const src = this._srcGrid;
    const dst = this._dstGrid;

    // Reset dst to src
    for (let r = 0; r <= ROWS; r++) {
      for (let c = 0; c <= COLS; c++) {
        dst[r][c].x = src[r][c].x;
        dst[r][c].y = src[r][c].y;
      }
    }

    // --- Jaw / mouth open ---
    const jaw = d.jawOpen * 0.06;
    if (jaw > 0.001) {
      const F = FEATURES;
      this._displace(F.lowerLip.x, F.lowerLip.y, 0, jaw, 0.12, 0.08, false);
      this._displace(F.jawCenter.x, F.jawCenter.y, 0, jaw * 0.7, 0.18, 0.12, false);
      this._displace(F.upperLip.x, F.upperLip.y, 0, -jaw * 0.15, 0.10, 0.04, false);
      this._displace(F.mouthLeft.x, F.mouthLeft.y, -jaw * 0.3, jaw * 0.2, 0.06, 0.06, false);
      this._displace(F.mouthRight.x, F.mouthRight.y, jaw * 0.3, jaw * 0.2, 0.06, 0.06, false);
    }

    // --- Lip stretch ---
    const stretch = d.lipStretch * 0.03;
    if (Math.abs(stretch) > 0.001) {
      this._displace(FEATURES.mouthLeft.x, FEATURES.mouthLeft.y, -stretch, 0, 0.06, 0.05, false);
      this._displace(FEATURES.mouthRight.x, FEATURES.mouthRight.y, stretch, 0, 0.06, 0.05, false);
    }

    // --- Lip pucker ---
    const pucker = d.lipPucker * 0.02;
    if (Math.abs(pucker) > 0.001) {
      this._displace(FEATURES.mouthLeft.x, FEATURES.mouthLeft.y, pucker, 0, 0.06, 0.05, false);
      this._displace(FEATURES.mouthRight.x, FEATURES.mouthRight.y, -pucker, 0, 0.06, 0.05, false);
    }

    // --- Mouth corner (smile / frown) ---
    const corner = d.mouthCorner * 0.025;
    if (Math.abs(corner) > 0.001) {
      this._displace(FEATURES.mouthLeft.x, FEATURES.mouthLeft.y, 0, -corner, 0.07, 0.06, false);
      this._displace(FEATURES.mouthRight.x, FEATURES.mouthRight.y, 0, -corner, 0.07, 0.06, false);
      this._displace(FEATURES.leftCheek.x, FEATURES.leftCheek.y, 0, -corner * 0.5, 0.10, 0.10, false);
      this._displace(FEATURES.rightCheek.x, FEATURES.rightCheek.y, 0, -corner * 0.5, 0.10, 0.10, false);
    }

    // --- Left brow raise ---
    const lbr = d.leftBrowRaise * 0.025;
    if (Math.abs(lbr) > 0.001) {
      this._displace(FEATURES.leftBrowC.x, FEATURES.leftBrowC.y, 0, -lbr, 0.10, 0.06, true);
    }

    // --- Right brow raise ---
    const rbr = d.rightBrowRaise * 0.025;
    if (Math.abs(rbr) > 0.001) {
      this._displace(FEATURES.rightBrowC.x, FEATURES.rightBrowC.y, 0, -rbr, 0.10, 0.06, true);
    }

    // --- Brow furrow ---
    const furrow = d.browFurrow * 0.015;
    if (furrow > 0.001) {
      this._displace(FEATURES.leftBrowIn.x, FEATURES.leftBrowIn.y, furrow, furrow * 0.5, 0.06, 0.05, true);
      this._displace(FEATURES.rightBrowIn.x, FEATURES.rightBrowIn.y, -furrow, furrow * 0.5, 0.06, 0.05, true);
    }

    // --- Eye widen (subtle vertical stretch around eyes) ---
    const ew = d.eyeWiden * 0.01;
    if (Math.abs(ew) > 0.001) {
      this._displace(FEATURES.leftEyeC.x, FEATURES.leftEyeC.y - 0.02, 0, -ew, 0.08, 0.04, true);
      this._displace(FEATURES.rightEyeC.x, FEATURES.rightEyeC.y - 0.02, 0, -ew, 0.08, 0.04, true);
    }

    // --- Head pose (yaw, pitch, roll) — applied to all vertices ---
    this._applyHeadPose();
  }

  /** @private */
  _applyHeadPose() {
    const d = this.deform;
    if (Math.abs(d.yaw) < 0.1 && Math.abs(d.pitch) < 0.1 && Math.abs(d.roll) < 0.1) return;

    const cx = this._w / 2;
    const cy = this._h / 2;
    const yawRad = d.yaw * Math.PI / 180;
    const pitchRad = d.pitch * Math.PI / 180;
    const rollRad = d.roll * Math.PI / 180;

    const cosR = Math.cos(rollRad);
    const sinR = Math.sin(rollRad);
    const scaleX = Math.cos(yawRad);
    const offsetX = Math.sin(yawRad) * this._w * 0.06;
    const scaleY = Math.cos(pitchRad);
    const offsetY = Math.sin(pitchRad) * this._h * 0.04;

    const dst = this._dstGrid;
    for (let r = 0; r <= ROWS; r++) {
      for (let c = 0; c <= COLS; c++) {
        const v = dst[r][c];

        // Yaw/pitch
        v.x = cx + (v.x - cx) * scaleX + offsetX;
        v.y = cy + (v.y - cy) * scaleY + offsetY;

        // Roll
        const rx = v.x - cx;
        const ry = v.y - cy;
        v.x = cx + rx * cosR - ry * sinR;
        v.y = cy + rx * sinR + ry * cosR;
      }
    }
  }

  // ==========================================================================
  // Mesh drawing
  // ==========================================================================

  /** @private */
  _drawMesh(ctx) {
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        this._drawCell(ctx, r, c);
      }
    }
  }

  /**
   * Draw a sub-region of the mesh (for re-drawing lips on top of mouth interior).
   * @private
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} xMin - Normalised left bound
   * @param {number} yMin - Normalised top bound
   * @param {number} xMax - Normalised right bound
   * @param {number} yMax - Normalised bottom bound
   */
  _drawMeshRegion(ctx, xMin, yMin, xMax, yMax) {
    const x0 = xMin * this._w;
    const y0 = yMin * this._h;
    const x1 = xMax * this._w;
    const y1 = yMax * this._h;

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const sv = this._srcGrid[r][c];
        const svr = this._srcGrid[r + 1][c + 1];
        // Check if cell overlaps the region
        if (sv.x < x1 && svr.x > x0 && sv.y < y1 && svr.y > y0) {
          this._drawCell(ctx, r, c);
        }
      }
    }
  }

  /**
   * Draw a single mesh cell using affine transform.
   * @private
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} r - Row
   * @param {number} c - Column
   */
  _drawCell(ctx, r, c) {
    const s0 = this._srcGrid[r][c];
    const s1 = this._srcGrid[r][c + 1];
    const s3 = this._srcGrid[r + 1][c];

    const d0 = this._dstGrid[r][c];
    const d1 = this._dstGrid[r][c + 1];
    const d2 = this._dstGrid[r + 1][c + 1];
    const d3 = this._dstGrid[r + 1][c];

    const sw = s1.x - s0.x;
    const sh = s3.y - s0.y;
    if (sw < 0.1 || sh < 0.1) return;

    ctx.save();

    // Clip to destination quad — expand by ~1px outward to eliminate seams
    const mx = (d0.x + d1.x + d2.x + d3.x) / 4;
    const my = (d0.y + d1.y + d2.y + d3.y) / 4;
    const pad = 1.0; // pixels
    const ex = (p) => {
      const dx = p.x - mx, dy = p.y - my;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      return { x: p.x + (dx / len) * pad, y: p.y + (dy / len) * pad };
    };
    const e0 = ex(d0), e1 = ex(d1), e2 = ex(d2), e3 = ex(d3);
    ctx.beginPath();
    ctx.moveTo(e0.x, e0.y);
    ctx.lineTo(e1.x, e1.y);
    ctx.lineTo(e2.x, e2.y);
    ctx.lineTo(e3.x, e3.y);
    ctx.closePath();
    ctx.clip();

    // Affine transform: map src triangle (s0, s1, s3) → dst triangle (d0, d1, d3)
    const a = (d1.x - d0.x) / sw;
    const b = (d3.x - d0.x) / sh;
    const cc = (d1.y - d0.y) / sw;
    const dd = (d3.y - d0.y) / sh;
    const e = d0.x - a * s0.x - b * s0.y;
    const f = d0.y - cc * s0.x - dd * s0.y;

    ctx.setTransform(a, cc, b, dd, e, f);
    ctx.drawImage(this._srcCanvas, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    ctx.restore();
  }

  // ==========================================================================
  // Mouth interior texture
  // ==========================================================================

  /** @private @returns {HTMLCanvasElement} */
  _buildMouthInterior() {
    const tw = Math.round(this._w * 0.22);
    const th = Math.round(this._h * 0.08);
    const tc = document.createElement('canvas');
    tc.width = tw;
    tc.height = th;
    const tctx = tc.getContext('2d');

    // Dark background gradient
    const bg = tctx.createLinearGradient(0, 0, 0, th);
    bg.addColorStop(0, 'rgb(20, 12, 12)');
    bg.addColorStop(1, 'rgb(50, 25, 20)');
    tctx.fillStyle = bg;
    tctx.fillRect(0, 0, tw, th);

    // Teeth suggestion (upper 40%)
    const teethH = th * 0.4;
    const tg = tctx.createLinearGradient(0, 0, 0, teethH);
    tg.addColorStop(0, 'rgba(230, 225, 218, 0.70)');
    tg.addColorStop(0.6, 'rgba(220, 215, 208, 0.40)');
    tg.addColorStop(1, 'rgba(210, 205, 198, 0)');
    tctx.fillStyle = tg;
    tctx.fillRect(tw * 0.15, 0, tw * 0.7, teethH);

    // Tooth separation lines
    tctx.strokeStyle = 'rgba(180, 175, 170, 0.15)';
    tctx.lineWidth = 0.5;
    const toothW = (tw * 0.7) / 6;
    for (let i = 1; i < 6; i++) {
      const tx = tw * 0.15 + toothW * i;
      tctx.beginPath();
      tctx.moveTo(tx, 1);
      tctx.lineTo(tx, teethH * 0.7);
      tctx.stroke();
    }

    return tc;
  }

  /** @private */
  _drawMouthInterior(ctx) {
    const d = this.deform;
    const F = FEATURES;
    const mcx = F.mouthCenter.x * this._w;
    const mcy = (F.upperLip.y + F.lowerLip.y) / 2 * this._h;
    const openAmount = d.jawOpen * 0.06 * this._h;
    const mw = this._w * 0.16 + d.lipStretch * this._w * 0.04;
    const mh = Math.max(4, openAmount * 0.7);

    ctx.save();

    // Ellipse clip
    ctx.beginPath();
    ctx.ellipse(mcx, mcy + openAmount * 0.3, mw / 2, mh / 2, 0, 0, Math.PI * 2);
    ctx.clip();

    // Draw the pre-built texture
    ctx.drawImage(this._mouthTex, mcx - mw / 2, mcy + openAmount * 0.3 - mh / 2, mw, mh);

    ctx.restore();
  }

  // ==========================================================================
  // Blink drawing (samples actual skin pixels from image)
  // ==========================================================================

  /**
   * Draw blink overlay using sampled eyelid skin texture.
   * @private
   * @param {CanvasRenderingContext2D} ctx
   * @param {number} eyeOpen - 0=closed, 1=fully open
   * @param {{x:number, y:number}} eyeFeature - Normalised eye center
   */
  _drawBlink(ctx, eyeOpen, eyeFeature) {
    const closedness = 1 - Math.max(0, Math.min(1, eyeOpen));
    if (closedness < 0.05) return;

    const ex = eyeFeature.x * this._w;
    const ey = eyeFeature.y * this._h;
    const ew = this._w * 0.08;
    const eh = this._h * 0.035;

    // Source: sample skin strip from above the eye
    const stripY = ey - eh * 1.5;
    const stripH = eh * 0.8;

    ctx.save();

    // Clip to eye ellipse
    ctx.beginPath();
    ctx.ellipse(ex, ey, ew, eh, 0, 0, Math.PI * 2);
    ctx.clip();

    // Draw skin strip stretched down over the eye
    ctx.globalAlpha = closedness * 0.92;
    ctx.drawImage(
      this._srcCanvas,
      ex - ew, stripY, ew * 2, stripH,       // source rectangle
      ex - ew, ey - eh * (1 - closedness), ew * 2, eh * 2  // dest: moves down as eye closes
    );

    // Subtle eyelid shadow
    const shadow = ctx.createLinearGradient(ex, ey - eh, ex, ey + eh * 0.3);
    shadow.addColorStop(0, `rgba(30, 20, 15, ${closedness * 0.25})`);
    shadow.addColorStop(1, 'rgba(30, 20, 15, 0)');
    ctx.globalAlpha = 1;
    ctx.fillStyle = shadow;
    ctx.fillRect(ex - ew, ey - eh, ew * 2, eh * 1.3);

    ctx.restore();
  }

  // ==========================================================================
  // Idle animations
  // ==========================================================================

  /** @private */
  _updateBlink(time) {
    if (!this.settings.blink) { this._blinkValue = 1; return; }

    const closeDur = 75;
    const holdDur = 40;
    const openDur = 110;

    if (this._blinkPhase === 0) {
      if (time >= this._nextBlinkTime) {
        this._blinkPhase = 1;
        this._blinkStart = time;
      }
    } else if (this._blinkPhase === 1) {
      const t = (time - this._blinkStart) / closeDur;
      this._blinkValue = Math.max(0, 1 - t);
      if (t >= 1) { this._blinkPhase = 2; this._blinkStart = time; }
    } else if (this._blinkPhase === 2) {
      this._blinkValue = 0;
      if (time - this._blinkStart >= holdDur) { this._blinkPhase = 3; this._blinkStart = time; }
    } else if (this._blinkPhase === 3) {
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
    this.deform.jawOpen = Math.max(this.deform.jawOpen, Math.max(0, breathVal));
  }

  /** @private */
  _micro() {
    const t = this._time / 1000;
    const p = this._perlin;
    const d = this.deform;

    d.mouthCorner = (d.mouthCorner || 0) + p.fbm(t * 0.28, 0) * 0.025;
    d.leftBrowRaise = (d.leftBrowRaise || 0) + p.fbm(t * 0.18, 10) * 0.018;
    d.rightBrowRaise = (d.rightBrowRaise || 0) + p.fbm(t * 0.18, 20) * 0.018;
    d.yaw = (d.yaw || 0) + p.fbm(t * 0.13, 30) * 1.2;
    d.pitch = (d.pitch || 0) + p.fbm(t * 0.10, 40) * 0.7;
    d.roll = (d.roll || 0) + p.fbm(t * 0.08, 50) * 0.4;
  }

  // ==========================================================================
  // Glasses detection
  // ==========================================================================

  /** @private @returns {boolean} */
  _detectGlasses() {
    try {
      const imgData = this._srcCtx.getImageData(0, 0, this._w, this._h);
      const data = imgData.data;

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
      console.log('[MeshWarp] Edge density: ' + edgeDensity.toFixed(3) + ' (threshold: 0.12)');
      return edgeDensity > 0.12;
    } catch (e) {
      console.warn('[MeshWarp] Glasses detection failed:', e);
      return false;
    }
  }
}

window.MeshWarpEngine = MeshWarpEngine;
