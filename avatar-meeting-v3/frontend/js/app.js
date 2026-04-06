/**
 * @fileoverview UI controller — integrates Engine with DOM events.
 */

const EMOTION_EMOJI = {
  joy: '😊', anger: '😠', sadness: '😢',
  surprise: '😲', fear: '😰', neutral: '😐',
};

class App {
  constructor() {
    /** @private {Engine|null} */ this._engine = null;
    /** @private */ this._micOn = false;
    /** @private */ this._camOn = false;
    /** @private */ this._vcamOn = false;
    /** @private */ this._vcamStream = null;
    /** @private */ this._vizRafId = null;
    /** @private */ this._el = {};
  }

  init() {
    const $ = (id) => document.getElementById(id);
    this._el = {
      canvas: $('av'), uploadArea: $('ua'), fileInput: $('fi'),
      thumb: $('th'), placeholder: $('ph'),
      btnMic: $('bm'), btnCam: $('bc'), btnVcam: $('bv'),
      vizWrap: $('vw'), statusEmo: $('se'), statusFps: $('sf'),
      statusSpk: $('ss'), statusHz: $('sh'), liveBadge: $('lb'),
      logBox: $('lg'),
    };

    // Build 32 visualizer bars
    if (this._el.vizWrap) {
      for (let i = 0; i < 32; i++) {
        const bar = document.createElement('div');
        bar.className = 'vb';
        this._el.vizWrap.appendChild(bar);
      }
    }

    // File input
    if (this._el.fileInput) {
      this._el.fileInput.addEventListener('change', (e) => {
        if (e.target.files[0]) this.loadPhoto(e.target.files[0]);
      });
    }

    // Drag & drop
    const ua = this._el.uploadArea;
    if (ua) {
      ua.addEventListener('dragover', (e) => { e.preventDefault(); ua.classList.add('over'); });
      ua.addEventListener('dragleave', () => ua.classList.remove('over'));
      ua.addEventListener('drop', (e) => {
        e.preventDefault(); ua.classList.remove('over');
        if (e.dataTransfer.files[0]) this.loadPhoto(e.dataTransfer.files[0]);
      });
      ua.addEventListener('click', () => { if (this._el.fileInput) this._el.fileInput.click(); });
    }

    // Buttons
    if (this._el.btnMic) this._el.btnMic.addEventListener('click', () => this.toggleMic());
    if (this._el.btnCam) this._el.btnCam.addEventListener('click', () => this.toggleCam());
    if (this._el.btnVcam) this._el.btnVcam.addEventListener('click', () => this.toggleVCam());

    // Setting toggles
    document.querySelectorAll('.tg').forEach((tog) => {
      tog.addEventListener('change', (e) => this.onSetting(e.target.id, e.target.checked));
    });

    this._setBtn(this._el.btnMic, false);
    this._setBtn(this._el.btnCam, false);
    this._setBtn(this._el.btnVcam, false);

    this.log('i', 'Avatar Meeting Studio v3 ready');
  }

  // ==========================================================================
  // Photo
  // ==========================================================================

  async loadPhoto(file) {
    if (!file.type.match(/^image\/(jpeg|png)$/)) { this.log('e', 'JPEG/PNG only'); return; }
    this.log('i', `Loading: ${file.name} (${(file.size / 1024).toFixed(0)}KB)`);

    if (this._el.thumb) {
      this._el.thumb.src = URL.createObjectURL(file);
      this._el.thumb.style.display = 'block';
    }

    try {
      if (!this._engine) {
        this._engine = new Engine(this._el.canvas);
        this._engine.onFPS = (fps) => {
          if (this._el.statusFps) this._el.statusFps.textContent = `FPS:${fps}`;
        };
        this._engine.onEmotion = (em) => {
          if (this._el.statusEmo) {
            const emoji = EMOTION_EMOJI[em.emotion] || '😐';
            this._el.statusEmo.textContent = `${emoji} ${em.emotion} ${Math.round(em.intensity * 100)}%`;
          }
        };
      }

      await this._engine.loadAvatar(file);

      if (this._el.canvas) this._el.canvas.style.display = 'block';
      if (this._el.placeholder) this._el.placeholder.style.display = 'none';

      this._setBtn(this._el.btnMic, true);
      this._setBtn(this._el.btnCam, true);
      this._setBtn(this._el.btnVcam, true);

      // Sync glasses toggle
      const gToggle = document.getElementById('t_glass');
      if (gToggle && this._engine.warp) gToggle.checked = this._engine.warp.hasGlasses;

      this._engine.start();
      this.log('s', `Avatar loaded (glasses: ${this._engine.warp?.hasGlasses ? 'yes' : 'no'})`);
    } catch (err) {
      this.log('e', `Load failed: ${err.message}`);
      console.error(err);
    }
  }

  // ==========================================================================
  // Mic
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
  // Camera
  // ==========================================================================

  async toggleCam() {
    if (!this._engine) return;
    if (!this._camOn) {
      const ok = await this._engine.startCamera();
      if (!ok) { this.log('w', 'Camera init failed'); return; }
      this._camOn = true;
      this._el.btnCam.textContent = '📹 カメラ OFF';
      this._el.btnCam.classList.add('active');
      this.log('s', 'Camera started — head tracking active');
    } else {
      this._camOn = false;
      if (this._engine._tracker) { this._engine._tracker.stop(); this._engine._tracker = null; }
      this._el.btnCam.textContent = '📹 カメラを有効化';
      this._el.btnCam.classList.remove('active');
      this.log('i', 'Camera stopped');
    }
  }

  // ==========================================================================
  // Virtual camera
  // ==========================================================================

  async toggleVCam() {
    if (!this._engine) return;
    if (!this._vcamOn) {
      try {
        this._vcamStream = this._engine.getStream(30);
        window._avatarStream = this._vcamStream;
        this._vcamOn = true;
        this._el.btnVcam.textContent = '🔄 仮想カメラ OFF';
        this._el.btnVcam.classList.add('active');
        if (this._el.liveBadge) this._el.liveBadge.style.display = 'flex';
        this.log('s', 'Virtual camera ON — window._avatarStream available');
      } catch (err) {
        this.log('e', `Virtual camera failed: ${err.message}`);
      }
    } else {
      this._vcamOn = false;
      if (this._vcamStream) { this._vcamStream.getTracks().forEach((t) => t.stop()); }
      window._avatarStream = null;
      this._el.btnVcam.textContent = '🔄 仮想カメラ ON';
      this._el.btnVcam.classList.remove('active');
      if (this._el.liveBadge) this._el.liveBadge.style.display = 'none';
      this.log('i', 'Virtual camera OFF');
    }
  }

  // ==========================================================================
  // Settings
  // ==========================================================================

  onSetting(id, isOn) {
    if (!this._engine?.warp) return;
    const s = this._engine.warp.settings;
    switch (id) {
      case 't_blink': s.blink = isOn; break;
      case 't_breath': s.breath = isOn; break;
      case 't_micro': s.micro = isOn; break;
      case 't_glass':
        this._engine.warp.hasGlasses = isOn;
        this.log('i', `Glasses protection: ${isOn ? 'ON' : 'OFF'}`);
        break;
    }
  }

  // ==========================================================================
  // Visualizer
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
        bars[i].style.height = `${Math.max(2, (data[i * step] / 255) * 100)}%`;
      }
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
    if (this._vizRafId) { cancelAnimationFrame(this._vizRafId); this._vizRafId = null; }
  }

  // ==========================================================================
  // Log
  // ==========================================================================

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
    while (box.children.length > 40) box.removeChild(box.firstChild);
    box.scrollTop = box.scrollHeight;
    const fn = level === 'e' ? 'error' : level === 'w' ? 'warn' : 'log';
    console[fn](`[App] ${message}`);
  }

  /** @private */
  _setBtn(btn, enabled) {
    if (!btn) return;
    btn.disabled = !enabled;
    btn.style.opacity = enabled ? '1' : '0.4';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();
  window._app = app;
});

window.App = App;
