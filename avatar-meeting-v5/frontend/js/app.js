/**
 * @fileoverview Main application controller for Avatar Meeting Studio v5.
 *
 * Orchestrates:
 *   - AvatarScene (Three.js 3D rendering)
 *   - FaceTracker (MediaPipe Face Landmarker)
 *   - VirtualCamera (canvas captureStream)
 *
 * Main loop runs at display refresh rate via requestAnimationFrame.
 * Each frame reads the latest FaceTracker results and passes them
 * to AvatarScene.update() for rendering.
 */

import { FaceTracker } from './face-tracker.js';
import { AvatarScene } from './avatar-scene.js';
import { VirtualCamera } from './virtual-camera.js';

class App {
  constructor() {
    /** @type {AvatarScene|null} */
    this.scene = null;
    /** @type {FaceTracker|null} */
    this.tracker = null;
    /** @type {VirtualCamera|null} */
    this.vcam = null;

    // FPS counter
    this._fpsFrames = 0;
    this._fpsTime = performance.now();
    this._fps = 0;
  }

  /** Initialize the application. */
  init() {
    // ----- DOM refs -----
    this._canvas = document.getElementById('avatar-canvas');
    this._urlInput = document.getElementById('avatar-url');
    this._loadBtn = document.getElementById('load-avatar');
    this._camBtn = document.getElementById('start-camera');
    this._vcamBtn = document.getElementById('start-vcam');
    this._smoothing = document.getElementById('smoothing');
    this._headStrength = document.getElementById('head-strength');
    this._mirrorChk = document.getElementById('mirror');
    this._loading = document.getElementById('loading');
    this._loadingText = document.getElementById('loading-text');
    this._lb = document.getElementById('lb');

    // ----- Create modules -----
    this.scene = new AvatarScene(this._canvas);
    this.vcam = new VirtualCamera(this._canvas);

    // ----- File drop / file input -----
    this._fileDrop = document.getElementById('file-drop');
    this._fileInput = document.getElementById('file-input');

    this._fileDrop.addEventListener('click', () => this._fileInput.click());
    this._fileInput.addEventListener('change', (e) => {
      if (e.target.files.length) this._loadAvatarFromFile(e.target.files[0]);
    });
    this._fileDrop.addEventListener('dragover', (e) => {
      e.preventDefault();
      this._fileDrop.classList.add('over');
    });
    this._fileDrop.addEventListener('dragleave', () => {
      this._fileDrop.classList.remove('over');
    });
    this._fileDrop.addEventListener('drop', (e) => {
      e.preventDefault();
      this._fileDrop.classList.remove('over');
      if (e.dataTransfer.files.length) this._loadAvatarFromFile(e.dataTransfer.files[0]);
    });

    // ----- Event listeners -----
    this._loadBtn.addEventListener('click', () => this._loadAvatar());
    this._camBtn.addEventListener('click', () => this._toggleCamera());
    this._vcamBtn.addEventListener('click', () => this._toggleVCam());

    this._smoothing.addEventListener('input', (e) => {
      this.scene.smoothing = parseFloat(e.target.value);
    });
    this._headStrength.addEventListener('input', (e) => {
      this.scene.headStrength = parseFloat(e.target.value);
    });
    this._mirrorChk.addEventListener('change', (e) => {
      this.scene.mirrored = e.target.checked;
    });

    // ----- Framing preset buttons -----
    document.querySelectorAll('[data-preset]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const preset = e.target.dataset.preset;
        this.scene.setFramingPreset(preset);
        document.querySelectorAll('[data-preset]').forEach((b) => b.classList.remove('active'));
        e.target.classList.add('active');
      });
    });

    // Zoom slider
    const zoomSlider = document.getElementById('zoom-slider');
    if (zoomSlider) {
      zoomSlider.addEventListener('input', (e) => {
        this.scene.setZoomLevel(parseFloat(e.target.value));
      });
    }

    // ----- VFX settings -----
    const vfxBindings = [
      ['vfx-enabled', 'enabled', 'checked'],
      ['vfx-bloom', 'bloom', 'value'],
      ['vfx-ssao', 'ssao', 'value'],
      ['vfx-dof', 'dof', 'value'],
      ['vfx-vignette', 'vignette', 'value'],
      ['vfx-grain', 'filmGrain', 'value'],
    ];
    for (const [id, key, prop] of vfxBindings) {
      const el = document.getElementById(id);
      if (!el) continue;
      const evtName = prop === 'checked' ? 'change' : 'input';
      el.addEventListener(evtName, (e) => {
        const val = prop === 'checked' ? e.target.checked : parseFloat(e.target.value);
        this.scene.vfx[key] = val;
      });
    }

    // ----- Auto-load default avatar -----
    this._loadAvatar();

    // ----- Start main loop -----
    this._loop();

    this._log('i', 'Avatar Meeting Studio v6 ready');
  }

  /**
   * Load avatar from a local .glb file.
   * @param {File} file
   * @private
   */
  async _loadAvatarFromFile(file) {
    if (!file) return;
    if (!file.name.endsWith('.glb') && !file.name.endsWith('.gltf')) {
      this._log('w', '.glb または .gltf ファイルを選択してください');
      return;
    }

    this._showLoading(`ローカルファイルをロード中...\n${file.name}`);
    try {
      await this.scene.loadAvatarFromFile(file);
      this._hideLoading();
      this._camBtn.disabled = false;
      this._vcamBtn.disabled = false;
      this._log('s', `ローカルアバター読み込み完了: ${file.name}`);
    } catch (err) {
      this._hideLoading();
      this._log('e', `読み込み失敗: ${err.message}`);
      console.error('[App] Local avatar load error:', err);
    }
  }

  /**
   * Load avatar from the URL input.
   * @private
   */
  async _loadAvatar() {
    const url = this._urlInput.value.trim();
    if (!url) return;

    this._showLoading('アバターをロード中...');
    try {
      await this.scene.loadAvatar(url);
      this._hideLoading();
      this._camBtn.disabled = false;
      this._vcamBtn.disabled = false;
      this._log('s', 'アバター読み込み完了');
    } catch (err) {
      this._hideLoading();
      this._log('e', `読み込み失敗: ${err.message}`);
      console.error('[App] Avatar load error:', err);
    }
  }

  /**
   * Toggle camera tracking on/off.
   * @private
   */
  async _toggleCamera() {
    if (!this.tracker) {
      this._showLoading('MediaPipe を初期化中...\n(初回は ~5MB ダウンロード)');
      this.tracker = new FaceTracker();
      const ok = await this.tracker.init();
      this._hideLoading();
      if (!ok) {
        this._log('e', 'カメラ初期化失敗');
        this.tracker = null;
        return;
      }
      this._camBtn.textContent = '📹 カメラ OFF';
      this._camBtn.classList.add('active');
      this._log('s', 'カメラ追跡開始 (MediaPipe Face Landmarker)');
    } else {
      this.tracker.stop();
      this.tracker = null;
      this._camBtn.textContent = '📹 カメラを有効化';
      this._camBtn.classList.remove('active');
      this._log('i', 'カメラ停止');
    }
  }

  /**
   * Toggle virtual camera output on/off.
   * @private
   */
  _toggleVCam() {
    if (!this.vcam.isActive) {
      this.vcam.start(30);
      this._vcamBtn.textContent = '🔄 仮想カメラ OFF';
      this._vcamBtn.classList.add('active');
      this._lb.style.display = 'flex';
      this._log('s', '仮想カメラ ON (window._avatarStream)');
    } else {
      this.vcam.stop();
      this._vcamBtn.textContent = '🔄 仮想カメラ ON';
      this._vcamBtn.classList.remove('active');
      this._lb.style.display = 'none';
      this._log('i', '仮想カメラ停止');
    }
  }

  /**
   * Main animation loop. Runs every frame.
   * Reads latest FaceTracker data and passes to AvatarScene.
   * @private
   */
  _loop() {
    requestAnimationFrame(() => this._loop());

    // FPS counter
    this._fpsFrames++;
    const now = performance.now();
    if (now - this._fpsTime >= 1000) {
      this._fps = this._fpsFrames;
      this._fpsFrames = 0;
      this._fpsTime = now;
      this._updateStatusBar();
    }

    // Pass latest tracker data to scene (empty object if no tracker)
    const blendShapes = this.tracker?.blendShapes || {};
    const matrix = this.tracker?.transformMatrix || null;
    this.scene.update(blendShapes, matrix);
  }

  /**
   * Update the status bar with current metrics.
   * @private
   */
  _updateStatusBar() {
    const sf = document.getElementById('sf');
    const sj = document.getElementById('sj');
    const sb = document.getElementById('sb');
    const sh = document.getElementById('sh');

    if (sf) sf.textContent = `FPS:${this._fps}`;

    if (this.tracker && this.tracker.faceDetected) {
      const bs = this.tracker.blendShapes;
      if (sj) sj.textContent = `jaw:${(bs.jawOpen || 0).toFixed(2)}`;
      if (sb) {
        const blink = ((bs.eyeBlinkLeft || 0) + (bs.eyeBlinkRight || 0)) / 2;
        sb.textContent = `blink:${blink.toFixed(2)}`;
      }
      if (sh && this.tracker.transformMatrix) {
        // Extract approximate yaw from the matrix
        const m = this.tracker.transformMatrix;
        const yaw = (Math.atan2(-m[2], m[0]) * 180 / Math.PI).toFixed(0);
        sh.textContent = `yaw:${yaw}\u00B0`;
      }
    }
  }

  /** @private */
  _showLoading(text) {
    this._loadingText.textContent = text;
    this._loading.style.display = 'flex';
  }

  /** @private */
  _hideLoading() {
    this._loading.style.display = 'none';
  }

  /**
   * Append a log message to the log panel.
   * @param {'i'|'s'|'e'|'w'} level
   * @param {string} message
   */
  _log(level, message) {
    const box = document.getElementById('log');
    if (!box) return;
    const ts = new Date().toLocaleTimeString('ja-JP', { hour12: false });
    const line = document.createElement('div');
    line.className = level;
    line.textContent = `[${ts}] ${message}`;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
    while (box.children.length > 50) box.removeChild(box.firstChild);
  }
}

// ----- Bootstrap -----
document.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();
  window._app = app;  // Debug access
});
