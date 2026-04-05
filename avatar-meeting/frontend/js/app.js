/**
 * @fileoverview Main application — integrates all modules into the Avatar Meeting system.
 */

import AvatarWebSocket from './websocket.js';
import AvatarCanvas from './avatar_canvas.js';
import AudioProcessor from './audio.js';
import WhisperSTT from './whisper_stt.js';
import FaceTracker from './face_tracker.js';
import EmotionAnalyzer from './emotion.js';
import VirtualCamera from './virtual_camera.js';

class AvatarMeetingApp {
  constructor() {
    /** @private */ this._ws = null;
    /** @private */ this._avatarCanvas = null;
    /** @private */ this._audio = null;
    /** @private */ this._stt = null;
    /** @private */ this._faceTracker = null;
    /** @private */ this._emotion = new EmotionAnalyzer();
    /** @private */ this._virtualCamera = null;
    /** @private */ this._avatarId = null;

    // Performance tracking
    /** @private */ this._chunkSendTimes = {};
    /** @private */ this._frameCount = 0;
    /** @private */ this._fpsStartTime = 0;
  }

  /**
   * Initialise all modules and bind UI events.
   */
  async init() {
    // Canvas
    const canvasEl = document.getElementById('avatar-canvas');
    if (canvasEl) {
      this._avatarCanvas = new AvatarCanvas(canvasEl);
    }

    // Emotion analyser
    this._emotion = new EmotionAnalyzer();

    // Bind UI events
    this._bindUI();

    this._updateStatusDisplay('ready');
    console.log('[App] Initialised');
  }

  // ---- Setup flows (triggered by UI) ----

  /**
   * Initialise microphone and audio capture.
   */
  async setupAudio() {
    try {
      this._audio = new AudioProcessor();
      await this._audio.init();
      this._audio.onChunk((pcm16) => this._onAudioChunk(pcm16));
      this._audio.onAmplitude((rms) => {
        if (this._avatarCanvas) this._avatarCanvas.setAudioAmplitude(rms);
      });

      // STT
      this._stt = new WhisperSTT();
      this._stt.init();
      this._stt.onText((text, isFinal) => {
        if (isFinal) this._onSpeechText(text);
      });

      this._audio.start();
      this._stt.start();

      this._updateStatusDisplay('audio_ready');
      console.log('[App] Audio setup complete');
    } catch (err) {
      this._handleError(err, 'setupAudio');
    }
  }

  /**
   * Initialise camera and face tracker.
   */
  async setupCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, frameRate: 30 },
      });

      const videoEl = document.getElementById('camera-preview');
      if (videoEl) {
        videoEl.srcObject = stream;
        await videoEl.play();
      }

      // Face tracker
      this._faceTracker = new FaceTracker();
      await this._faceTracker.init();

      // Head pose → avatar (with warm-up)
      let poseFrameCount = 0;
      this._faceTracker.onHeadPose((pose) => {
        poseFrameCount++;
        // Discard first 30 frames (warm-up jitter)
        if (poseFrameCount <= 30) return;
        if (poseFrameCount === 31 && this._avatarCanvas) {
          this._avatarCanvas.enableHeadPose();
        }
        this._onHeadPose(pose);
      });

      // Camera facial features → avatar deformation
      this._faceTracker.onFacialFeatures((features) => {
        if (this._avatarCanvas) {
          this._avatarCanvas.setFacialFeatures(features);
        }
      });

      if (videoEl) {
        this._faceTracker.start(videoEl);
      }

      // Virtual camera
      if (this._avatarCanvas) {
        this._virtualCamera = new VirtualCamera(this._avatarCanvas.canvas);
      }

      this._updateStatusDisplay('camera_ready');
      console.log('[App] Camera setup complete');
    } catch (err) {
      this._handleError(err, 'setupCamera');
    }
  }

  /**
   * Upload avatar photo and prepare on server.
   * @param {File} photoFile
   */
  async setupAvatar(photoFile) {
    try {
      this._updateStatusDisplay('preparing');

      const formData = new FormData();
      formData.append('file', photoFile);

      const resp = await fetch('/api/prepare_avatar', {
        method: 'POST',
        body: formData,
      });

      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.error || `HTTP ${resp.status}`);
      }

      const data = await resp.json();
      this._avatarId = data.avatar_id;

      // Display the avatar image on canvas immediately
      if (data.image && this._avatarCanvas) {
        await this._avatarCanvas.showStaticImage(data.image);
      }

      // Connect WebSocket
      await this.connectWebSocket();

      this._updateStatusDisplay('avatar_ready');
      if (!data.musetalk) {
        console.warn('[App] MuseTalk not available — using local lip-sync');
      }
      console.log('[App] Avatar prepared:', this._avatarId);
    } catch (err) {
      this._handleError(err, 'setupAvatar');
    }
  }

  /**
   * Establish WebSocket connection.
   */
  async connectWebSocket() {
    try {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${location.host}/ws/lipsync`;

      this._ws = new AvatarWebSocket(url);
      this._ws.onAudioChunk((data) => this._onAudioReceived(data));
      this._ws.onFrames((data) => this._onFramesReceived(data));
      this._ws.onDone((data) => this._onDone(data));
      this._ws.onError((err) => this._handleError(err, 'websocket'));
      this._ws.onReconnect(() => {
        console.log('[App] WebSocket reconnected');
        if (this._avatarId) this._ws.sendConfig(this._avatarId);
      });

      await this._ws.connect();

      if (this._avatarId) {
        this._ws.sendConfig(this._avatarId);
      }

      console.log('[App] WebSocket connected');
    } catch (err) {
      this._handleError(err, 'connectWebSocket');
    }
  }

  // ---- Data flow handlers ----

  /**
   * Audio chunk captured from microphone → send to server.
   * @private
   */
  _onAudioChunk(pcm16) {
    if (this._ws && this._ws.isConnected) {
      const chunkId = Date.now();
      this._chunkSendTimes[chunkId] = performance.now();
      this._ws.sendAudioChunk(pcm16);
    }
  }

  /**
   * Speech-to-text result → emotion analysis.
   * @private
   */
  _onSpeechText(text) {
    const result = this._emotion.analyze(text);
    this._updateEmotionDisplay(result);
    if (this._avatarCanvas) {
      this._avatarCanvas.setEmotion(result.params, result.emotion);
    }
  }

  /**
   * Head pose from face tracker → avatar canvas.
   * Now passes through to LipSyncLocal for subtle translation.
   * @private
   */
  _onHeadPose(pose) {
    if (this._avatarCanvas) {
      this._avatarCanvas.setHeadPose(pose.yaw, pose.pitch, pose.roll);
    }
  }

  /**
   * Audio data received from server.
   *
   * NOTE: The server echoes the user's own audio back as part of the
   * audio-first pattern. We do NOT mute the mic here because:
   * 1) The echoed audio is never played through speakers
   * 2) Muting kills the audio RMS that drives lip-sync
   * 3) getUserMedia echoCancellation handles actual speaker echo
   *
   * @private
   */
  _onAudioReceived(data) {
    // No-op: do NOT mute the microphone.
    // The server echoes our audio back but we don't play it.
    // Muting here was causing RMS=0 which killed lip-sync entirely.
  }

  /**
   * Lip-sync frames received from server.
   * @private
   */
  _onFramesReceived(data) {
    if (!this._avatarCanvas) return;
    const now = performance.now();
    this._updateFrameRate();
    this._avatarCanvas.scheduleFrames(data.chunk_id, data.frames, now);
  }

  /**
   * Chunk processing complete.
   * @private
   */
  _onDone(data) {
    if (this._avatarCanvas) {
      this._avatarCanvas.handleDone(data.chunk_id);
    }
    delete this._chunkSendTimes[data.chunk_id];
  }

  // ---- UI updates ----

  /** @private */
  _updateEmotionDisplay(result) {
    const el = document.getElementById('emotion-display');
    if (el) {
      el.textContent = `${result.emoji} ${result.emotion} (${Math.round(result.confidence * 100)}%)`;
    }
  }

  /** @private */
  _updateLatencyDisplay(ms) {
    const el = document.getElementById('latency-display');
    if (el) el.textContent = `${Math.round(ms)}ms`;
  }

  /** @private */
  _updateStatusDisplay(state) {
    const el = document.getElementById('status-display');
    const indicator = document.getElementById('status-indicator');
    if (!el) return;

    const states = {
      ready:        { text: '待機中',             color: 'var(--color-warning)' },
      preparing:    { text: 'アバター準備中...',   color: 'var(--color-warning)' },
      audio_ready:  { text: 'マイク有効',          color: 'var(--color-success)' },
      camera_ready: { text: 'カメラ有効',          color: 'var(--color-success)' },
      avatar_ready: { text: '接続完了',            color: 'var(--color-success)' },
      error:        { text: 'エラー',              color: 'var(--color-error)' },
      disconnected: { text: '切断',                color: 'var(--color-error)' },
    };

    const s = states[state] || states.ready;
    el.textContent = s.text;
    if (indicator) indicator.style.backgroundColor = s.color;
  }

  /** @private */
  _updateFrameRate() {
    this._frameCount++;
    const now = performance.now();
    if (now - this._fpsStartTime >= 1000) {
      const fps = this._frameCount;
      this._frameCount = 0;
      this._fpsStartTime = now;
      const el = document.getElementById('fps-display');
      if (el) el.textContent = `${fps} fps`;
    }
  }

  // ---- Error handling ----

  /** @private */
  _handleError(error, context) {
    console.error(`[App] Error in ${context}:`, error);
    this._updateStatusDisplay('error');

    const el = document.getElementById('error-display');
    if (el) {
      el.textContent = `${context}: ${error.message}`;
      el.style.display = 'block';
      setTimeout(() => { el.style.display = 'none'; }, 5000);
    }
  }

  // ---- UI bindings ----

  /** @private */
  _bindUI() {
    // Photo upload
    const photoInput = document.getElementById('photo-input');
    const photoBtn = document.getElementById('btn-photo');
    if (photoInput) {
      photoInput.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (file) {
          if (photoBtn) {
            photoBtn.textContent = 'アップロード中...';
            photoBtn.disabled = true;
          }
          await this.setupAvatar(file);
          if (photoBtn) {
            photoBtn.textContent = '写真を変更';
            photoBtn.disabled = false;
            photoBtn.classList.add('active');
          }
        }
      });
    }

    // Mic button
    const micBtn = document.getElementById('btn-mic');
    if (micBtn) {
      micBtn.addEventListener('click', async () => {
        await this.setupAudio();
        micBtn.classList.add('active');
        micBtn.textContent = 'マイク有効';
      });
    }

    // Camera button
    const camBtn = document.getElementById('btn-camera');
    if (camBtn) {
      camBtn.addEventListener('click', async () => {
        await this.setupCamera();
        camBtn.classList.add('active');
        camBtn.textContent = 'カメラ有効';
      });
    }

    // Virtual camera toggle
    const vcBtn = document.getElementById('btn-virtual-camera');
    if (vcBtn) {
      vcBtn.addEventListener('click', async () => {
        if (!this._virtualCamera) {
          console.warn('[App] Setup camera first');
          return;
        }
        const stream = await this._virtualCamera.toggle();
        if (stream) {
          vcBtn.classList.add('active');
          vcBtn.textContent = '仮想カメラ ON';
          const badge = document.getElementById('live-badge');
          if (badge) badge.style.display = 'block';
        } else {
          vcBtn.classList.remove('active');
          vcBtn.textContent = '仮想カメラ OFF';
          const badge = document.getElementById('live-badge');
          if (badge) badge.style.display = 'none';
        }
      });
    }
  }
}

// ---- Bootstrap ----
document.addEventListener('DOMContentLoaded', async () => {
  const app = new AvatarMeetingApp();
  await app.init();
  window.__avatarApp = app; // expose for debugging
});

export default AvatarMeetingApp;
