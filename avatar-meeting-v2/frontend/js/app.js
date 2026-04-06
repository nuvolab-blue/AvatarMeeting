/**
 * @fileoverview Main UI controller — integrates all modules with DOM events.
 *
 * Handles:
 *  - Photo upload (file input + drag & drop)
 *  - Mic / Camera / Virtual Camera toggle
 *  - Settings toggles (blink, breath, micro, glasses)
 *  - Audio visualizer bar animation
 *  - Status bar updates (emotion, FPS, pitch)
 *  - Log panel
 */

import FaceEngine from './face-engine.js';
import FaceTracker from './face-tracker.js';
import VirtualCamera from './virtual-camera.js';

/** Emotion → emoji map */
const EMOTION_EMOJI = {
  joy: '😊', anger: '😠', sadness: '😢',
  surprise: '😲', fear: '😰', neutral: '😐',
};

class App {
  constructor() {
    /** @private {FaceEngine|null} */ this._engine = null;
    /** @private {FaceTracker|null} */ this._tracker = null;
    /** @private {VirtualCamera|null} */ this._vcam = null;

    /** @private */ this._micOn = false;
    /** @private */ this._camOn = false;
    /** @private */ this._vcamOn = false;
    /** @private */ this._vizRafId = null;

    // DOM references (set in init)
    /** @private */ this._el = {};
  }

  /** Initialize after DOM ready. */
  init() {
    // Cache DOM elements
    const $ = (id) => document.getElementById(id);
    this._el = {
      canvas:     $('av'),
      uploadArea: $('ua'),
      fileInput:  $('fi'),
      thumb:      $('th'),
      placeholder:$('ph'),
      btnMic:     $('bm'),
      btnCam:     $('bc'),
      btnVcam:    $('bv'),
      vizWrap:    $('vw'),
      statusEmo:  $('se'),
      statusFps:  $('sf'),
      statusSpk:  $('ss'),
      statusHz:   $('sh'),
      liveBadge:  $('lb'),
      logBox:     $('lg'),
    };

    // Build visualizer bars (32)
    if (this._el.vizWrap) {
      for (let i = 0; i < 32; i++) {
        const bar = document.createElement('div');
        bar.className = 'vb';
        this._el.vizWrap.appendChild(bar);
      }
    }

    // -- File input --
    if (this._el.fileInput) {
      this._el.fileInput.addEventListener('change', (e) => {
        if (e.target.files[0]) this.loadPhoto(e.target.files[0]);
      });
    }

    // -- Drag & drop --
    const ua = this._el.uploadArea;
    if (ua) {
      ua.addEventListener('dragover', (e) => { e.preventDefault(); ua.classList.add('over'); });
      ua.addEventListener('dragleave', () => { ua.classList.remove('over'); });
      ua.addEventListener('drop', (e) => {
        e.preventDefault();
        ua.classList.remove('over');
        const f = e.dataTransfer.files[0];
        if (f) this.loadPhoto(f);
      });
      ua.addEventListener('click', () => {
        if (this._el.fileInput) this._el.fileInput.click();
      });
    }

    // -- Buttons --
    if (this._el.btnMic) this._el.btnMic.addEventListener('click', () => this.toggleMic());
    if (this._el.btnCam) this._el.btnCam.addEventListener('click', () => this.toggleCam());
    if (this._el.btnVcam) this._el.btnVcam.addEventListener('click', () => this.toggleVCam());

    // -- Setting toggles --
    document.querySelectorAll('.tg').forEach((tog) => {
      tog.addEventListener('change', (e) => {
        this.onSetting(e.target.id, e.target.checked);
      });
    });

    // Disable buttons until photo loaded
    this._setBtn(this._el.btnMic, false);
    this._setBtn(this._el.btnCam, false);
    this._setBtn(this._el.btnVcam, false);

    this.log('i', 'Avatar Meeting Studio v2 ready');
  }

  // ==========================================================================
  // Photo loading
  // ==========================================================================

  /**
   * Load photo and initialize avatar.
   * @param {File} file
   */
  async loadPhoto(file) {
    // Validate
    if (!file.type.match(/^image\/(jpeg|png)$/)) {
      this.log('e', 'JPEG/PNG only');
      return;
    }

    this.log('i', `Loading: ${file.name} (${(file.size / 1024).toFixed(0)}KB)`);

    // Show thumbnail
    if (this._el.thumb) {
      this._el.thumb.src = URL.createObjectURL(file);
      this._el.thumb.style.display = 'block';
    }

    try {
      // Create engine (once)
      if (!this._engine) {
        this._engine = new FaceEngine(this._el.canvas);

        this._engine.onFPS = (fps) => {
          if (this._el.statusFps) this._el.statusFps.textContent = `FPS:${fps}`;
        };

        this._engine.onEmotion = (em) => {
          if (this._el.statusEmo) {
            const emoji = EMOTION_EMOJI[em.emotion] || '😐';
            const pct = Math.round(em.intensity * 100);
            this._el.statusEmo.textContent = `${emoji} ${em.emotion} ${pct}%`;
          }
        };
      }

      await this._engine.loadAvatar(file);

      // Show canvas, hide placeholder
      if (this._el.canvas) this._el.canvas.style.display = 'block';
      if (this._el.placeholder) this._el.placeholder.style.display = 'none';

      // Enable buttons
      this._setBtn(this._el.btnMic, true);
      this._setBtn(this._el.btnCam, true);
      this._setBtn(this._el.btnVcam, true);

      // Update glasses toggle
      if (this._engine.deformer) {
        const gToggle = document.getElementById('t_glass');
        if (gToggle) gToggle.checked = this._engine.deformer.hasGlasses;
      }

      // Start engine
      this._engine.start();

      this.log('s', `Avatar loaded (glasses: ${this._engine.deformer?.hasGlasses ? 'yes' : 'no'})`);
    } catch (err) {
      this.log('e', `Load failed: ${err.message}`);
      console.error(err);
    }
  }

  // ==========================================================================
  // Mic toggle
  // ==========================================================================

  async toggleMic() {
    if (!this._engine) return;

    if (!this._micOn) {
      const ok = await this._engine.startAudio();
      if (!ok) { this.log('e', 'Mic init failed'); return; }

      this._micOn = true;
      this._el.btnMic.textContent = '🎤 マイク OFF';
      this._el.btnMic.classList.add('active');
      if (this._el.statusSpk) this._el.statusSpk.textContent = '🔊';
      if (this._el.vizWrap) this._el.vizWrap.style.display = 'flex';

      // Start visualizer
      this._startVisualizer();

      this.log('s', 'Mic started — lip-sync + emotion active');
    } else {
      this._micOn = false;
      this._engine.audio.stop();
      this._el.btnMic.textContent = '🎤 マイクを有効化';
      this._el.btnMic.classList.remove('active');
      if (this._el.statusSpk) this._el.statusSpk.textContent = '🔇';
      if (this._el.vizWrap) this._el.vizWrap.style.display = 'none';
      this._stopVisualizer();

      this.log('i', 'Mic stopped');
    }
  }

  // ==========================================================================
  // Camera toggle
  // ==========================================================================

  async toggleCam() {
    if (!this._engine) return;

    if (!this._camOn) {
      this._tracker = new FaceTracker();
      const ok = await this._engine.startCamera(this._tracker);
      if (!ok) { this.log('w', 'Camera init failed (MediaPipe may not be loaded)'); return; }

      this._camOn = true;
      this._el.btnCam.textContent = '📹 カメラ OFF';
      this._el.btnCam.classList.add('active');
      this.log('s', 'Camera started — head tracking active');
    } else {
      this._camOn = false;
      if (this._tracker) { this._tracker.stop(); this._tracker = null; }
      this._el.btnCam.textContent = '📹 カメラを有効化';
      this._el.btnCam.classList.remove('active');
      this.log('i', 'Camera stopped');
    }
  }

  // ==========================================================================
  // Virtual camera toggle
  // ==========================================================================

  async toggleVCam() {
    if (!this._engine) return;

    if (!this._vcamOn) {
      this._vcam = new VirtualCamera(this._el.canvas);
      try {
        await this._vcam.start();
        this._vcamOn = true;
        this._el.btnVcam.textContent = '🔄 仮想カメラ OFF';
        this._el.btnVcam.classList.add('active');
        if (this._el.liveBadge) this._el.liveBadge.style.display = 'flex';
        this.log('s', 'Virtual camera ON — use window._avatarStream in Meet/Slack');
      } catch (err) {
        this.log('e', `Virtual camera failed: ${err.message}`);
      }
    } else {
      this._vcamOn = false;
      if (this._vcam) { this._vcam.stop(); this._vcam = null; }
      this._el.btnVcam.textContent = '🔄 仮想カメラ ON';
      this._el.btnVcam.classList.remove('active');
      if (this._el.liveBadge) this._el.liveBadge.style.display = 'none';
      this.log('i', 'Virtual camera OFF');
    }
  }

  // ==========================================================================
  // Settings
  // ==========================================================================

  /**
   * @param {string} id - Toggle element ID
   * @param {boolean} isOn
   */
  onSetting(id, isOn) {
    if (!this._engine?.deformer) return;
    const s = this._engine.deformer.settings;

    switch (id) {
      case 't_blink': s.blink = isOn; break;
      case 't_breath': s.breath = isOn; break;
      case 't_micro': s.micro = isOn; break;
      case 't_glass':
        this._engine.deformer.hasGlasses = isOn;
        this.log('i', `Glasses protection: ${isOn ? 'ON' : 'OFF'}`);
        break;
    }
  }

  // ==========================================================================
  // Audio Visualizer
  // ==========================================================================

  /** @private */
  _startVisualizer() {
    const bars = this._el.vizWrap?.querySelectorAll('.vb');
    if (!bars || !this._engine?.audio?.analyser) return;

    const analyser = this._engine.audio.analyser;
    const data = new Uint8Array(analyser.frequencyBinCount);
    const step = Math.floor(data.length / 32);

    const loop = () => {
      if (!this._micOn) return;
      this._vizRafId = requestAnimationFrame(loop);

      analyser.getByteFrequencyData(data);

      for (let i = 0; i < 32; i++) {
        const val = data[i * step] / 255;
        bars[i].style.height = `${Math.max(2, val * 100)}%`;
      }

      // Update speaking / pitch
      if (this._el.statusSpk) {
        this._el.statusSpk.textContent = this._engine.audio.isSpeaking ? '🔊' : '🔇';
      }
      if (this._el.statusHz) {
        this._el.statusHz.textContent = `${Math.round(this._engine.audio.pitch)}Hz`;
      }
    };

    this._vizRafId = requestAnimationFrame(loop);
  }

  /** @private */
  _stopVisualizer() {
    if (this._vizRafId) {
      cancelAnimationFrame(this._vizRafId);
      this._vizRafId = null;
    }
  }

  // ==========================================================================
  // Log
  // ==========================================================================

  /**
   * @param {'i'|'s'|'w'|'e'} level
   * @param {string} message
   */
  log(level, message) {
    const box = this._el.logBox;
    if (!box) { console.log(`[${level}]`, message); return; }

    const now = new Date();
    const ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
      .map((n) => String(n).padStart(2, '0')).join(':');

    const line = document.createElement('div');
    line.className = `ll ${level}`;
    line.textContent = `[${ts}] ${message}`;
    box.appendChild(line);

    // Keep max 40 lines
    while (box.children.length > 40) box.removeChild(box.firstChild);

    box.scrollTop = box.scrollHeight;

    // Also to console
    const fn = level === 'e' ? 'error' : level === 'w' ? 'warn' : 'log';
    console[fn](`[App] ${message}`);
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /** @private */
  _setBtn(btn, enabled) {
    if (!btn) return;
    btn.disabled = !enabled;
    btn.style.opacity = enabled ? '1' : '0.4';
  }
}

// Auto-init on DOM ready
document.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();
  window._app = app;
});

export default App;
