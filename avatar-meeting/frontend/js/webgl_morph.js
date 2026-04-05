/**
 * @fileoverview GPU-accelerated face morphing engine using WebGL mesh warping.
 *
 * VFX approach:
 *  1. Triangulate face landmarks (Delaunay) + border points → triangle mesh
 *  2. Map original avatar image as texture (UV = rest landmark positions)
 *  3. Deform vertex positions based on facial parameters
 *  4. GPU renders warped triangles with smooth barycentric interpolation
 *  5. Mouth cavity via per-vertex darkness in fragment shader
 *
 * Coordinate convention:
 *  - MediaPipe landmarks: x ∈ [0,1] left→right, y ∈ [0,1] top→bottom
 *  - WebGL clip space:    x ∈ [-1,1] left→right, y ∈ [-1,1] bottom→top
 *  - Texture (no flip):   u ∈ [0,1] left→right, v ∈ [0,1] top→bottom (matches MediaPipe)
 */

// ============================================================================
// Shaders
// ============================================================================
const VERT_SRC = `
attribute vec2 a_position;   // normalized 0..1 (MediaPipe convention)
attribute vec2 a_texCoord;   // same space
attribute float a_cavity;
varying vec2 v_texCoord;
varying float v_cavity;
void main() {
  // Convert MediaPipe coords to clip space
  float cx = a_position.x * 2.0 - 1.0;   // 0..1 → -1..1
  float cy = 1.0 - a_position.y * 2.0;    // 0..1 → 1..-1 (flip Y for GL)
  gl_Position = vec4(cx, cy, 0.0, 1.0);
  v_texCoord = a_texCoord;
  v_cavity = a_cavity;
}
`;

const FRAG_SRC = `
precision mediump float;
varying vec2 v_texCoord;
varying float v_cavity;
uniform sampler2D u_image;
uniform float u_mouthOpen;
void main() {
  vec4 tex = texture2D(u_image, v_texCoord);
  // Darken mouth interior when open
  float dark = v_cavity * smoothstep(0.0, 0.08, u_mouthOpen);
  vec3 cavColor = vec3(0.04, 0.01, 0.01);
  gl_FragColor = vec4(mix(tex.rgb, cavColor, dark), 1.0);
}
`;

// ============================================================================
// Face landmark region indices (MediaPipe FaceMesh 468-point)
// ============================================================================
const UPPER_INNER_LIP = new Set([13, 82, 81, 80, 191, 78, 312, 311, 310, 415, 308]);
const LOWER_INNER_LIP = new Set([14, 87, 88, 95, 178, 317, 318, 402, 324]);
const LIP_CORNERS     = new Set([61, 291]);
const UPPER_OUTER_LIP = new Set([0, 37, 39, 40, 185, 267, 269, 270, 409]);
const LOWER_OUTER_LIP = new Set([17, 84, 181, 91, 146, 314, 405, 321, 375]);

const CHIN_SET = new Set([
  152, 148, 176, 149, 150, 136, 172, 58, 132,
  377, 378, 379, 365, 397, 288, 361, 323, 454,
]);

const UPPER_LID_L = new Set([159, 160, 161, 246, 158, 157, 173]);
const UPPER_LID_R = new Set([386, 385, 384, 398, 387, 388, 466]);
const LOWER_LID_L = new Set([145, 144, 163, 7, 153, 154, 155]);
const LOWER_LID_R = new Set([374, 380, 381, 382, 373, 390, 249]);

const BROW_L = new Set([46, 53, 52, 65, 55, 107, 66, 105, 63, 70]);
const BROW_R = new Set([276, 283, 282, 295, 285, 336, 296, 334, 293, 300]);

const FOREHEAD = new Set([10, 109, 67, 103, 54, 21, 338, 297, 332, 284, 251]);

const NOSE_BRIDGE = new Set([6, 197, 195, 5, 4, 1, 168, 8]);

// Border anchors (pinned — never deform)
const BORDER_POINTS = [
  [0,0],[.2,0],[.4,0],[.5,0],[.6,0],[.8,0],[1,0],
  [0,.15],[1,.15],
  [0,.3],[1,.3],
  [0,.5],[1,.5],
  [0,.7],[1,.7],
  [0,.85],[1,.85],
  [0,1],[.2,1],[.4,1],[.5,1],[.6,1],[.8,1],[1,1],
];

// ============================================================================
// Per-landmark deformation weights: [mouthDy, browDy, eyeDy, headW, cavityW]
// ============================================================================
function landmarkWeights(idx) {
  // ---- Mouth region ----
  // Inner lip: main mouth opening deformation (subtle — avoid face collapse)
  if (UPPER_INNER_LIP.has(idx)) return [-0.30,  0,    0,   0.3, 0.85];
  if (LOWER_INNER_LIP.has(idx)) return [ 0.55,  0,    0,   0.3, 0.85];
  if (LIP_CORNERS.has(idx))     return [ 0.02,  0,    0,   0.3, 0.3];
  // Outer lip: follows inner lip at reduced strength
  if (UPPER_OUTER_LIP.has(idx)) return [-0.12,  0,    0,   0.3, 0.0];
  if (LOWER_OUTER_LIP.has(idx)) return [ 0.30,  0,    0,   0.3, 0.0];
  // Chin: very gentle follow to avoid face stretching
  if (CHIN_SET.has(idx))         return [ 0.10,  0,    0,   0.3, 0.0];

  // ---- Eyelids: VERY subtle to avoid distorting glasses ----
  if (UPPER_LID_L.has(idx) || UPPER_LID_R.has(idx)) return [0, 0, -0.35, 0.3, 0];
  if (LOWER_LID_L.has(idx) || LOWER_LID_R.has(idx)) return [0, 0,  0.12, 0.3, 0];

  // ---- Brows: gentle raise, no wave ----
  if (BROW_L.has(idx) || BROW_R.has(idx))           return [0, -0.40, 0,  0.3, 0];
  if (FOREHEAD.has(idx))                              return [0, -0.12, 0,  0.3, 0];

  // ---- Nose: fixed ----
  if (NOSE_BRIDGE.has(idx))                           return [0, 0, 0, 0.15, 0];

  // ---- Default face landmark: minimal head movement ----
  return [0, 0, 0, 0.2, 0];
}

// ============================================================================
// Delaunay Triangulation (Bowyer-Watson)
// ============================================================================
function triangulate(points) {
  const n = points.length;
  if (n < 3) return [];

  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const p of points) {
    if (p.x < xmin) xmin = p.x; if (p.x > xmax) xmax = p.x;
    if (p.y < ymin) ymin = p.y; if (p.y > ymax) ymax = p.y;
  }
  const d = Math.max(xmax - xmin, ymax - ymin, 1) * 200;
  const mx = (xmin + xmax) / 2, my = (ymin + ymax) / 2;

  const all = points.concat([
    { x: mx - d, y: my - d },
    { x: mx + d, y: my - d },
    { x: mx, y: my + d },
  ]);

  function circumscribe(ia, ib, ic) {
    const a = all[ia], b = all[ib], c = all[ic];
    const D = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(D) < 1e-12) return { cx: 0, cy: 0, r2: 1e18 };
    const a2 = a.x * a.x + a.y * a.y;
    const b2 = b.x * b.x + b.y * b.y;
    const c2 = c.x * c.x + c.y * c.y;
    const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / D;
    const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / D;
    const ex = a.x - ux, ey = a.y - uy;
    return { cx: ux, cy: uy, r2: ex * ex + ey * ey };
  }

  let tris = [{ v: [n, n + 1, n + 2], cc: circumscribe(n, n + 1, n + 2) }];

  for (let i = 0; i < n; i++) {
    const p = all[i];
    const bad = [];
    for (let j = 0; j < tris.length; j++) {
      const c = tris[j].cc;
      const dx = p.x - c.cx, dy = p.y - c.cy;
      if (dx * dx + dy * dy <= c.r2 + 1e-10) bad.push(j);
    }

    const edges = [];
    for (const j of bad) {
      const [a, b, c] = tris[j].v;
      edges.push([a, b], [b, c], [c, a]);
    }

    const boundary = [];
    for (let e = 0; e < edges.length; e++) {
      let shared = false;
      for (let f = 0; f < edges.length; f++) {
        if (e !== f && edges[e][0] === edges[f][1] && edges[e][1] === edges[f][0]) {
          shared = true; break;
        }
      }
      if (!shared) boundary.push(edges[e]);
    }

    for (let j = bad.length - 1; j >= 0; j--) tris.splice(bad[j], 1);

    for (const [a, b] of boundary) {
      tris.push({ v: [a, b, i], cc: circumscribe(a, b, i) });
    }
  }

  return tris.filter(t => t.v.every(v => v < n)).map(t => t.v);
}

// ============================================================================
// WebGLMorph
// ============================================================================
class WebGLMorph {
  constructor() {
    this._canvas = document.createElement('canvas');
    this._gl = null;
    this._program = null;
    this._texture = null;

    this._aPosition = -1;
    this._aTexCoord = -1;
    this._aCavity = -1;
    this._uImage = null;
    this._uMouthOpen = null;

    this._posBuf = null;
    this._texBuf = null;
    this._cavBuf = null;
    this._idxBuf = null;

    this._numVerts = 0;
    this._numIndices = 0;
    this._numDeform = 0; // vertices that can deform

    this._restPos = null;
    this._curPos = null;
    this._weights = null;

    this._ready = false;
  }

  get canvas() { return this._canvas; }
  get isReady() { return this._ready; }

  /**
   * @param {HTMLImageElement} image
   * @param {Array|null} landmarks
   * @returns {boolean}
   */
  init(image, landmarks) {
    const w = image.naturalWidth || image.width;
    const h = image.naturalHeight || image.height;
    this._canvas.width = w;
    this._canvas.height = h;

    const gl = this._canvas.getContext('webgl', {
      premultipliedAlpha: false,
      alpha: false,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    if (!gl) { console.error('[Morph] No WebGL'); return false; }
    this._gl = gl;

    this._program = this._compile(VERT_SRC, FRAG_SRC);
    if (!this._program) return false;

    gl.useProgram(this._program);
    this._aPosition  = gl.getAttribLocation(this._program, 'a_position');
    this._aTexCoord  = gl.getAttribLocation(this._program, 'a_texCoord');
    this._aCavity    = gl.getAttribLocation(this._program, 'a_cavity');
    this._uImage     = gl.getUniformLocation(this._program, 'u_image');
    this._uMouthOpen = gl.getUniformLocation(this._program, 'u_mouthOpen');

    this._texture = this._uploadTex(image);

    if (landmarks && landmarks.length >= 468) {
      this._buildFromLandmarks(landmarks);
    } else {
      this._buildGrid();
    }

    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    this._ready = true;

    console.log('[Morph] Ready: %d verts, %d tris, %d deformable',
      this._numVerts, this._numIndices / 3, this._numDeform);
    return true;
  }

  /**
   * Render with deformation.
   * @param {object} p
   * @param {number} p.mouthOpen  0..1
   * @param {number} p.browRaise  0..1
   * @param {number} p.eyeWide   -0.5..0.5
   * @param {number} p.headX      normalised shift
   * @param {number} p.headY      normalised shift
   */
  render(p) {
    if (!this._ready) return;
    const gl = this._gl;

    // Reset to rest positions
    this._curPos.set(this._restPos);

    // Deformation amounts in normalised coords (0..1 space)
    // Keep SMALL to avoid face collapse — mesh warping amplifies visually
    const mouth = (p.mouthOpen || 0) * 0.035; // max 3.5% of image height
    const brow  = (p.browRaise || 0) * 0.012; // max 1.2%
    const eye   = (p.eyeWide   || 0) * 0.008; // max 0.8% (subtle for glasses)
    const hx = p.headX || 0;
    const hy = p.headY || 0;

    const wt = this._weights;
    const pos = this._curPos;
    const nd = this._numDeform;

    for (let i = 0; i < nd; i++) {
      const wi = i * 5;
      const pi = i * 2;

      // Y deformation: mouth + brow + eye (positive = downward in MediaPipe coords)
      pos[pi + 1] += wt[wi] * mouth + wt[wi + 1] * brow + wt[wi + 2] * eye;

      // X/Y shift from head pose
      const hw = wt[wi + 3];
      pos[pi]     += hx * hw;
      pos[pi + 1] += hy * hw;
    }

    // Upload
    gl.bindBuffer(gl.ARRAY_BUFFER, this._posBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos);

    // Draw
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this._program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this._texture);
    gl.uniform1i(this._uImage, 0);
    gl.uniform1f(this._uMouthOpen, p.mouthOpen || 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this._posBuf);
    gl.enableVertexAttribArray(this._aPosition);
    gl.vertexAttribPointer(this._aPosition, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this._texBuf);
    gl.enableVertexAttribArray(this._aTexCoord);
    gl.vertexAttribPointer(this._aTexCoord, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this._cavBuf);
    gl.enableVertexAttribArray(this._aCavity);
    gl.vertexAttribPointer(this._aCavity, 1, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._idxBuf);
    gl.drawElements(gl.TRIANGLES, this._numIndices, gl.UNSIGNED_SHORT, 0);
  }

  // ==========================================================================
  // Mesh building
  // ==========================================================================

  _buildFromLandmarks(lm) {
    const gl = this._gl;
    const pts = [];
    const wts = [];

    for (let i = 0; i < 468; i++) {
      pts.push({ x: lm[i].x, y: lm[i].y });
      wts.push(...landmarkWeights(i));
    }

    // Add border anchors
    for (const [bx, by] of BORDER_POINTS) {
      pts.push({ x: bx, y: by });
      wts.push(0, 0, 0, 0, 0);
    }

    const { merged, map } = this._dedup(pts, 0.003);
    const rawTris = triangulate(merged);

    const nv = merged.length;
    const rest = new Float32Array(nv * 2);
    const tex  = new Float32Array(nv * 2);
    const cav  = new Float32Array(nv);
    const mw   = new Float32Array(nv * 5);

    for (let i = 0; i < nv; i++) {
      rest[i * 2]     = merged[i].x;
      rest[i * 2 + 1] = merged[i].y;
      tex[i * 2]      = merged[i].x;
      tex[i * 2 + 1]  = merged[i].y;
    }

    for (let i = 0; i < pts.length; i++) {
      const mi = map[i];
      const si = i * 5, di = mi * 5;
      if (i < 468 || mw[di + 3] === 0) {
        for (let k = 0; k < 5; k++) mw[di + k] = wts[si + k];
      }
      cav[mi] = Math.max(cav[mi], wts[si + 4]);
    }

    const idx = new Uint16Array(rawTris.length * 3);
    let ii = 0;
    for (const [a, b, c] of rawTris) { idx[ii++] = a; idx[ii++] = b; idx[ii++] = c; }

    this._numVerts = nv;
    this._numIndices = idx.length;
    this._numDeform = nv; // all can deform (border weights = 0 keep them pinned)
    this._restPos = rest;
    this._curPos = new Float32Array(rest);
    this._weights = mw;

    this._posBuf = this._makeBuf(gl.ARRAY_BUFFER, rest, gl.DYNAMIC_DRAW);
    this._texBuf = this._makeBuf(gl.ARRAY_BUFFER, tex, gl.STATIC_DRAW);
    this._cavBuf = this._makeBuf(gl.ARRAY_BUFFER, cav, gl.STATIC_DRAW);
    this._idxBuf = this._makeBuf(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  }

  _buildGrid() {
    const gl = this._gl;
    const cols = 30, rows = 40;
    const nv = (cols + 1) * (rows + 1);
    const rest = new Float32Array(nv * 2);
    const tex  = new Float32Array(nv * 2);
    const cav  = new Float32Array(nv);
    const wts  = new Float32Array(nv * 5);

    // Approximate face feature positions (centered portrait)
    const cx = 0.5, mouthY = 0.62, browY = 0.32, eyeY = 0.40;
    const eyeLX = 0.38, eyeRX = 0.62;

    let vi = 0;
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        const x = c / cols, y = r / rows;
        rest[vi * 2] = x;
        rest[vi * 2 + 1] = y;
        tex[vi * 2] = x;
        tex[vi * 2 + 1] = y;

        // Face proximity
        const fd = Math.sqrt((x - cx) ** 2 + ((y - 0.45) * 1.2) ** 2);
        const headW = Math.max(0, 1 - fd / 0.35);

        // Mouth influence (reduced to avoid face collapse)
        const md = Math.sqrt((x - cx) ** 2 + ((y - mouthY) * 1.8) ** 2);
        const mi = Math.max(0, 1 - md / 0.10);
        const mDy = mi * (y > mouthY ? 0.50 : -0.28);
        const cv = md < 0.05 ? mi * 0.8 : 0;

        // Brow (gentle)
        const bd = Math.sqrt((x - cx) ** 2 + ((y - browY) * 2.5) ** 2);
        const bDy = Math.max(0, 1 - bd / 0.12) * -0.40;

        // Eyes (very subtle — glasses-safe)
        const edL = Math.sqrt(((x - eyeLX) * 3) ** 2 + ((y - eyeY) * 6) ** 2);
        const edR = Math.sqrt(((x - eyeRX) * 3) ** 2 + ((y - eyeY) * 6) ** 2);
        const ei = Math.max(0, 1 - Math.min(edL, edR) / 0.15);
        const eDy = ei * (y < eyeY ? -0.35 : 0.12);

        wts[vi * 5]     = mDy;
        wts[vi * 5 + 1] = bDy;
        wts[vi * 5 + 2] = eDy;
        wts[vi * 5 + 3] = headW;
        wts[vi * 5 + 4] = cv;
        cav[vi] = cv;
        vi++;
      }
    }

    const numT = cols * rows * 2;
    const idx = new Uint16Array(numT * 3);
    let ii = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const tl = r * (cols + 1) + c, tr = tl + 1;
        const bl = tl + cols + 1, br = bl + 1;
        idx[ii++] = tl; idx[ii++] = bl; idx[ii++] = tr;
        idx[ii++] = tr; idx[ii++] = bl; idx[ii++] = br;
      }
    }

    this._numVerts = nv;
    this._numDeform = nv;
    this._numIndices = idx.length;
    this._restPos = rest;
    this._curPos = new Float32Array(rest);
    this._weights = wts;

    this._posBuf = this._makeBuf(gl.ARRAY_BUFFER, rest, gl.DYNAMIC_DRAW);
    this._texBuf = this._makeBuf(gl.ARRAY_BUFFER, tex, gl.STATIC_DRAW);
    this._cavBuf = this._makeBuf(gl.ARRAY_BUFFER, cav, gl.STATIC_DRAW);
    this._idxBuf = this._makeBuf(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  _dedup(pts, minD) {
    const merged = [];
    const map = new Array(pts.length);
    const md2 = minD * minD;
    for (let i = 0; i < pts.length; i++) {
      let f = -1;
      for (let j = 0; j < merged.length; j++) {
        const dx = pts[i].x - merged[j].x, dy = pts[i].y - merged[j].y;
        if (dx * dx + dy * dy < md2) { f = j; break; }
      }
      if (f >= 0) { map[i] = f; }
      else { map[i] = merged.length; merged.push({ x: pts[i].x, y: pts[i].y }); }
    }
    return { merged, map };
  }

  _makeBuf(target, data, usage) {
    const gl = this._gl;
    const buf = gl.createBuffer();
    gl.bindBuffer(target, buf);
    gl.bufferData(target, data, usage);
    return buf;
  }

  _compile(vSrc, fSrc) {
    const gl = this._gl;
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vSrc); gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      console.error('[Morph] VS:', gl.getShaderInfoLog(vs)); return null;
    }
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fSrc); gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.error('[Morph] FS:', gl.getShaderInfoLog(fs)); return null;
    }
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error('[Morph] Link:', gl.getProgramInfoLog(p)); return null;
    }
    return p;
  }

  _uploadTex(image) {
    const gl = this._gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    // NO FLIP — MediaPipe y=0 is top, texture v=0 is also top row
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  }
}

export default WebGLMorph;
