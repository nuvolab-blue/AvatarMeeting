/**
 * @fileoverview GPU-accelerated face morphing engine using WebGL mesh warping.
 *
 * VFX approach:
 *  1. Triangulate face landmarks (Delaunay) + border points → triangle mesh
 *  2. Map original avatar image as texture (UV = rest landmark positions)
 *  3. Deform vertex positions based on facial parameters (mouth, eyes, brows, head)
 *  4. GPU renders warped triangles with smooth barycentric interpolation
 *  5. Mouth cavity rendered via per-vertex darkness attribute
 *
 * This produces cinema-quality morphing — no rectangular cutouts or artifacts.
 */

// ============================================================================
// WebGL Shaders
// ============================================================================
const VERT_SRC = `
attribute vec2 a_position;
attribute vec2 a_texCoord;
attribute float a_cavity;
varying vec2 v_texCoord;
varying float v_cavity;
void main() {
  vec2 clip = a_position * 2.0 - 1.0;
  clip.y = -clip.y;
  gl_Position = vec4(clip, 0.0, 1.0);
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
  float dark = v_cavity * smoothstep(0.0, 0.12, u_mouthOpen);
  vec3 cavityColor = vec3(0.05, 0.015, 0.015);
  gl_FragColor = vec4(mix(tex.rgb, cavityColor, dark), 1.0);
}
`;

// ============================================================================
// Landmark region definitions (MediaPipe FaceMesh 468-point indices)
// ============================================================================
const UPPER_INNER_LIP = new Set([13, 82, 81, 80, 191, 312, 311, 310, 415]);
const LOWER_INNER_LIP = new Set([14, 87, 88, 95, 178, 317, 318, 402, 324]);
const LIP_CORNERS     = new Set([78, 308]);
const UPPER_OUTER_LIP = new Set([0, 37, 39, 40, 185, 61, 267, 269, 270, 409, 291]);
const LOWER_OUTER_LIP = new Set([17, 84, 181, 91, 146, 314, 405, 321, 375]);

const CHIN_SET = new Set([152, 148, 176, 149, 150, 136, 172, 58, 377, 378, 379, 365, 397, 288, 361, 323]);

const UPPER_LID_L = new Set([159, 160, 161, 246, 158, 157, 173]);
const UPPER_LID_R = new Set([386, 385, 384, 398, 387, 388, 466]);
const LOWER_LID_L = new Set([145, 144, 163, 7, 153, 154, 155]);
const LOWER_LID_R = new Set([374, 380, 381, 382, 373, 390, 249]);

const BROW_L = new Set([46, 53, 52, 65, 55, 107, 66, 105, 63, 70]);
const BROW_R = new Set([276, 283, 282, 295, 285, 336, 296, 334, 293, 300]);

const FOREHEAD = new Set([10, 109, 67, 103, 54, 21, 338, 297, 332, 284, 251]);

// Border points (pinned — never deform). Normalized 0..1 coordinates.
const BORDER_POINTS = [
  {x:0,y:0},{x:.25,y:0},{x:.5,y:0},{x:.75,y:0},{x:1,y:0},
  {x:0,y:.25},{x:1,y:.25},
  {x:0,y:.5},{x:1,y:.5},
  {x:0,y:.75},{x:1,y:.75},
  {x:0,y:1},{x:.25,y:1},{x:.5,y:1},{x:.75,y:1},{x:1,y:1},
];

// ============================================================================
// Delaunay Triangulation (Bowyer-Watson)
// ============================================================================
function triangulate(points) {
  const n = points.length;
  if (n < 3) return [];

  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    if (p.x < xmin) xmin = p.x; if (p.x > xmax) xmax = p.x;
    if (p.y < ymin) ymin = p.y; if (p.y > ymax) ymax = p.y;
  }
  const d = Math.max(xmax - xmin, ymax - ymin, 1) * 200;
  const mx = (xmin + xmax) / 2, my = (ymin + ymax) / 2;

  const allPts = points.concat([
    { x: mx - d, y: my - d },
    { x: mx + d, y: my - d },
    { x: mx, y: my + d },
  ]);

  function cc(ia, ib, ic) {
    const a = allPts[ia], b = allPts[ib], c = allPts[ic];
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

  let tris = [{ v: [n, n + 1, n + 2], cc: cc(n, n + 1, n + 2) }];

  for (let i = 0; i < n; i++) {
    const p = allPts[i];
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

    const sorted = bad.slice().sort((a, b) => b - a);
    for (const j of sorted) tris.splice(j, 1);

    for (const [a, b] of boundary) {
      const c0 = cc(a, b, i);
      tris.push({ v: [a, b, i], cc: c0 });
    }
  }

  return tris.filter(t => t.v.every(v => v < n)).map(t => t.v);
}

// ============================================================================
// Deformation weight assignment
// ============================================================================
// Returns [mouthDy, browDy, eyeDy, headW, cavityW] for a face landmark index
function landmarkWeights(idx) {
  if (UPPER_INNER_LIP.has(idx)) return [-0.40, 0, 0, 1, 1.0];
  if (LOWER_INNER_LIP.has(idx)) return [ 0.70, 0, 0, 1, 1.0];
  if (LIP_CORNERS.has(idx))     return [ 0.02, 0, 0, 1, 0.5];
  if (UPPER_OUTER_LIP.has(idx)) return [-0.18, 0, 0, 1, 0.0];
  if (LOWER_OUTER_LIP.has(idx)) return [ 0.50, 0, 0, 1, 0.0];
  if (CHIN_SET.has(idx))         return [ 0.22, 0, 0, 1, 0.0];
  if (UPPER_LID_L.has(idx) || UPPER_LID_R.has(idx)) return [0, 0, -1.0, 1, 0];
  if (LOWER_LID_L.has(idx) || LOWER_LID_R.has(idx)) return [0, 0,  0.35, 1, 0];
  if (BROW_L.has(idx) || BROW_R.has(idx))           return [0, -1.0, 0, 1, 0];
  if (FOREHEAD.has(idx))                              return [0, -0.3, 0, 1, 0];
  return [0, 0, 0, 1, 0]; // default face landmark: head-only
}

// ============================================================================
// WebGLMorph class
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
    this._numLandmarks = 0; // face landmarks count (rest are border)

    this._restPos = null;   // Float32Array [x0,y0, x1,y1,...] normalized 0..1
    this._curPos = null;    // Float32Array (mutated each frame)
    this._weights = null;   // Float32Array [mouthDy,browDy,eyeDy,headW,cavW,...] per landmark

    this._ready = false;
  }

  get canvas() { return this._canvas; }
  get isReady() { return this._ready; }

  /**
   * Initialize WebGL, build mesh, upload texture.
   * @param {HTMLImageElement} image
   * @param {Array|null} landmarks - 468 MediaPipe FaceMesh landmarks (normalized 0..1)
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
    if (!gl) { console.error('[WebGLMorph] No WebGL'); return false; }
    this._gl = gl;

    this._program = this._buildProgram(VERT_SRC, FRAG_SRC);
    if (!this._program) return false;

    gl.useProgram(this._program);
    this._aPosition = gl.getAttribLocation(this._program, 'a_position');
    this._aTexCoord = gl.getAttribLocation(this._program, 'a_texCoord');
    this._aCavity   = gl.getAttribLocation(this._program, 'a_cavity');
    this._uImage    = gl.getUniformLocation(this._program, 'u_image');
    this._uMouthOpen = gl.getUniformLocation(this._program, 'u_mouthOpen');

    this._texture = this._uploadTexture(image);

    if (landmarks && landmarks.length >= 468) {
      this._buildLandmarkMesh(landmarks);
    } else {
      this._buildGridMesh();
    }

    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);

    this._ready = true;
    console.log('[WebGLMorph] Ready: %d verts, %d tris', this._numVerts, this._numIndices / 3);
    return true;
  }

  /**
   * Render with deformation applied.
   * @param {object} p
   * @param {number} p.mouthOpen  0..1
   * @param {number} p.browRaise  0..1
   * @param {number} p.eyeWide   -0.5..0.5
   * @param {number} p.headX      normalized shift
   * @param {number} p.headY      normalized shift
   */
  render(p) {
    if (!this._ready) return;
    const gl = this._gl;

    // Reset positions to rest
    this._curPos.set(this._restPos);

    const h = this._canvas.height;
    const mouthPx = (p.mouthOpen || 0) * h * 0.07;
    const browPx  = (p.browRaise || 0) * h * 0.025;
    const eyePx   = (p.eyeWide || 0) * h * 0.018;
    const hx = p.headX || 0;
    const hy = p.headY || 0;

    // Apply deformation to each face landmark vertex
    const wt = this._weights;
    const pos = this._curPos;
    const nLm = this._numLandmarks;

    for (let i = 0; i < nLm; i++) {
      const wi = i * 5;
      const mDy = wt[wi];
      const bDy = wt[wi + 1];
      const eDy = wt[wi + 2];
      const hW  = wt[wi + 3];

      const pi = i * 2;
      pos[pi]     += hx * hW;
      pos[pi + 1] += (mDy * mouthPx + bDy * browPx + eDy * eyePx) / h + hy * hW;
    }

    // Upload deformed positions
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
  // Private: mesh building
  // ==========================================================================

  /** Build mesh from 468 FaceMesh landmarks + border points. */
  _buildLandmarkMesh(landmarks) {
    const gl = this._gl;
    const pts = [];
    const weights = [];

    // Add 468 face landmarks
    for (let i = 0; i < 468; i++) {
      pts.push({ x: landmarks[i].x, y: landmarks[i].y });
      weights.push(...landmarkWeights(i));
    }
    this._numLandmarks = 468;

    // Add border points (pinned: all weights = 0)
    for (const bp of BORDER_POINTS) {
      pts.push({ x: bp.x, y: bp.y });
      weights.push(0, 0, 0, 0, 0);
    }

    // Deduplicate very close points
    const { mergedPts, indexMap } = this._dedup(pts, 0.002);

    // Delaunay triangulate
    const rawTris = triangulate(mergedPts);

    // Build vertex/index arrays (use merged points)
    const numV = mergedPts.length;
    const restPos = new Float32Array(numV * 2);
    const texCoords = new Float32Array(numV * 2);
    const cavity = new Float32Array(numV);
    const mergedWeights = new Float32Array(numV * 5);

    for (let i = 0; i < numV; i++) {
      restPos[i * 2] = mergedPts[i].x;
      restPos[i * 2 + 1] = mergedPts[i].y;
      texCoords[i * 2] = mergedPts[i].x;
      texCoords[i * 2 + 1] = mergedPts[i].y;
    }

    // Map weights from original to merged indices
    for (let i = 0; i < pts.length; i++) {
      const mi = indexMap[i];
      const si = i * 5, di = mi * 5;
      // Keep the first mapping (landmark weights take priority over border)
      if (i < 468 || mergedWeights[di + 3] === 0) {
        for (let k = 0; k < 5; k++) mergedWeights[di + k] = weights[si + k];
      }
      cavity[mi] = Math.max(cavity[mi], weights[si + 4]);
    }

    // Index buffer
    const indices = new Uint16Array(rawTris.length * 3);
    let idx = 0;
    for (const [a, b, c] of rawTris) {
      indices[idx++] = a;
      indices[idx++] = b;
      indices[idx++] = c;
    }

    // Store
    this._numVerts = numV;
    this._numIndices = indices.length;
    this._restPos = restPos;
    this._curPos = new Float32Array(restPos);
    this._weights = mergedWeights;
    // Update numLandmarks to account for merged points
    this._numLandmarks = numV - BORDER_POINTS.length;

    // Create GPU buffers
    this._posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, restPos, gl.DYNAMIC_DRAW);

    this._texBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._texBuf);
    gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);

    this._cavBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._cavBuf);
    gl.bufferData(gl.ARRAY_BUFFER, cavity, gl.STATIC_DRAW);

    this._idxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  }

  /** Build a regular grid mesh as fallback (no landmarks). */
  _buildGridMesh() {
    const gl = this._gl;
    const cols = 32, rows = 40;
    const numV = (cols + 1) * (rows + 1);
    const restPos = new Float32Array(numV * 2);
    const texCoords = new Float32Array(numV * 2);
    const cavity = new Float32Array(numV);
    const weights = new Float32Array(numV * 5);

    // Estimated face geometry (portrait photo)
    const faceCX = 0.5, faceCY = 0.45, faceR = 0.28;
    const mouthCX = 0.5, mouthCY = 0.62, mouthR = 0.10;
    const browCY = 0.32, browR = 0.15;
    const eyeLX = 0.38, eyeRX = 0.62, eyeCY = 0.40, eyeR = 0.06;

    let vi = 0;
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c <= cols; c++) {
        const nx = c / cols, ny = r / rows;
        restPos[vi * 2] = nx;
        restPos[vi * 2 + 1] = ny;
        texCoords[vi * 2] = nx;
        texCoords[vi * 2 + 1] = ny;

        // Compute weights based on proximity to face features
        const faceDist = Math.sqrt((nx - faceCX) ** 2 + (ny - faceCY) ** 2);
        const headW = Math.max(0, 1 - faceDist / (faceR * 1.3));

        const mouthDist = Math.sqrt((nx - mouthCX) ** 2 + ((ny - mouthCY) * 1.5) ** 2);
        const mouthInf = Math.max(0, 1 - mouthDist / mouthR);
        const mouthDy = mouthInf * (ny > mouthCY ? 0.6 : -0.35);
        const cavW = mouthDist < mouthR * 0.5 ? mouthInf : 0;

        const browDist = Math.sqrt((nx - faceCX) ** 2 + ((ny - browCY) * 2) ** 2);
        const browDy = Math.max(0, 1 - browDist / browR) * -1.0;

        const eyeDistL = Math.sqrt(((nx - eyeLX) * 2) ** 2 + ((ny - eyeCY) * 4) ** 2);
        const eyeDistR = Math.sqrt(((nx - eyeRX) * 2) ** 2 + ((ny - eyeCY) * 4) ** 2);
        const eyeDist = Math.min(eyeDistL, eyeDistR);
        const eyeInf = Math.max(0, 1 - eyeDist / (eyeR * 3));
        const eyeDy = eyeInf * (ny < eyeCY ? -0.8 : 0.3);

        weights[vi * 5]     = mouthDy;
        weights[vi * 5 + 1] = browDy;
        weights[vi * 5 + 2] = eyeDy;
        weights[vi * 5 + 3] = headW;
        weights[vi * 5 + 4] = cavW;
        cavity[vi] = cavW;

        vi++;
      }
    }

    // Grid triangulation
    const numTris = cols * rows * 2;
    const indices = new Uint16Array(numTris * 3);
    let ii = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const tl = r * (cols + 1) + c;
        const tr = tl + 1;
        const bl = tl + (cols + 1);
        const br = bl + 1;
        indices[ii++] = tl; indices[ii++] = bl; indices[ii++] = tr;
        indices[ii++] = tr; indices[ii++] = bl; indices[ii++] = br;
      }
    }

    this._numVerts = numV;
    this._numLandmarks = numV; // all grid vertices can deform
    this._numIndices = indices.length;
    this._restPos = restPos;
    this._curPos = new Float32Array(restPos);
    this._weights = weights;

    this._posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, restPos, gl.DYNAMIC_DRAW);

    this._texBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._texBuf);
    gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);

    this._cavBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this._cavBuf);
    gl.bufferData(gl.ARRAY_BUFFER, cavity, gl.STATIC_DRAW);

    this._idxBuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this._idxBuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
  }

  // ==========================================================================
  // Private: utilities
  // ==========================================================================

  /** Merge points closer than minDist. */
  _dedup(points, minDist) {
    const mergedPts = [];
    const indexMap = new Array(points.length);
    const md2 = minDist * minDist;

    for (let i = 0; i < points.length; i++) {
      let found = -1;
      for (let j = 0; j < mergedPts.length; j++) {
        const dx = points[i].x - mergedPts[j].x;
        const dy = points[i].y - mergedPts[j].y;
        if (dx * dx + dy * dy < md2) { found = j; break; }
      }
      if (found >= 0) {
        indexMap[i] = found;
      } else {
        indexMap[i] = mergedPts.length;
        mergedPts.push({ x: points[i].x, y: points[i].y });
      }
    }
    return { mergedPts, indexMap };
  }

  /** Compile and link shader program. */
  _buildProgram(vsSrc, fsSrc) {
    const gl = this._gl;
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vsSrc);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      console.error('[WebGLMorph] VS:', gl.getShaderInfoLog(vs));
      return null;
    }
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fsSrc);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.error('[WebGLMorph] FS:', gl.getShaderInfoLog(fs));
      return null;
    }
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('[WebGLMorph] Link:', gl.getProgramInfoLog(prog));
      return null;
    }
    return prog;
  }

  /** Upload image as WebGL texture. */
  _uploadTexture(image) {
    const gl = this._gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  }
}

export default WebGLMorph;
