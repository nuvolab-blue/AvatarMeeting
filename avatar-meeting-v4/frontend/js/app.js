/**
 * @fileoverview UI Controller for Avatar Meeting Studio v4.
 *
 * Handles drag-and-drop image upload, mic/camera/vcam toggles,
 * audio visualizer, BlendShape debug display, and log panel.
 */

document.addEventListener('DOMContentLoaded', () => {
  // ---- DOM refs ----
  const canvas    = document.getElementById('av');
  const ph        = document.getElementById('placeholder');
  const liveBadge = document.getElementById('live-badge');
  const camPip    = document.getElementById('cam-pip');
  const camVideo  = document.getElementById('cam-video');

  const uploadArea = document.getElementById('upload-area');
  const fileInput  = document.getElementById('file-input');
  const previewImg = document.getElementById('preview-img');

  const btnMic  = document.getElementById('btn-mic');
  const btnCam  = document.getElementById('btn-cam');
  const btnVcam = document.getElementById('btn-vcam');
  const togGlasses = document.getElementById('tog-glasses');
  const togBlink   = document.getElementById('tog-blink');
  const togBreath  = document.getElementById('tog-breath');
  const togMicro   = document.getElementById('tog-micro');

  const vizWrap = document.getElementById('viz-wrap');
  const logBox  = document.getElementById('log-box');

  // Status
  const sFPS     = document.getElementById('sfps');
  const sEmo     = document.getElementById('semo');
  const sBS      = document.getElementById('sbs');
  const sJawOpen = document.getElementById('sjaw');

  // BlendShape debug bars
  const barJaw   = document.getElementById('bar-jaw');
  const barBlink = document.getElementById('bar-blink');
  const barSmile = document.getElementById('bar-smile');

  // ---- Engine ----
  const engine = new Engine(canvas);

  // ---- Logging ----
  function log(msg, cls = 'i') {
    const el = document.createElement('div');
    el.className = `ll ${cls}`;
    el.textContent = `${new Date().toLocaleTimeString()} ${msg}`;
    logBox.appendChild(el);
    logBox.scrollTop = logBox.scrollHeight;
    // Keep last 200 lines
    while (logBox.children.length > 200) logBox.removeChild(logBox.firstChild);
  }

  // ---- Image upload ----
  function handleFile(file) {
    if (!file || !file.type.startsWith('image/')) {
      log('画像ファイルを選択してください', 'w');
      return;
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
      previewImg.src = e.target.result;
      previewImg.style.display = 'block';

      try {
        await engine.loadAvatar(file);
        canvas.style.display = 'block';
        ph.style.display = 'none';
        liveBadge.style.display = 'flex';
        engine.start();
        log('アバター読み込み完了 (WebGL2 GPU)', 's');

        // Enable buttons
        btnMic.disabled = false;
        btnCam.disabled = false;
      } catch (err) {
        log(`アバター読み込みエラー: ${err.message}`, 'e');
      }
    };
    reader.readAsDataURL(file);
  }

  uploadArea.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) handleFile(e.target.files[0]);
  });

  // Drag and drop
  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('over');
  });
  uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('over');
  });
  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('over');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });

  // ---- Mic toggle ----
  let micActive = false;
  btnMic.addEventListener('click', async () => {
    if (!micActive) {
      btnMic.textContent = '⏳ マイク接続中...';
      const ok = await engine.startAudio();
      if (ok) {
        micActive = true;
        btnMic.classList.add('active');
        btnMic.textContent = '🎤 マイク ON';
        vizWrap.style.display = 'flex';
        setupVisualizer();
        log('マイク有効化', 's');
      } else {
        btnMic.textContent = '🎤 マイクを有効化';
        log('マイク初期化失敗', 'e');
      }
    } else {
      engine.audio.stop();
      micActive = false;
      btnMic.classList.remove('active');
      btnMic.textContent = '🎤 マイクを有効化';
      vizWrap.style.display = 'none';
      log('マイク停止', 'i');
    }
  });

  // ---- Camera toggle ----
  let camActive = false;
  btnCam.addEventListener('click', async () => {
    if (!camActive) {
      btnCam.textContent = '⏳ モデルダウンロード中...';
      btnCam.disabled = true;

      const ok = await engine.startCamera();
      btnCam.disabled = false;

      if (ok) {
        camActive = true;
        btnCam.classList.add('active');
        btnCam.textContent = '📷 カメラ ON';
        log('カメラ有効化 — MediaPipe BlendShape', 's');

        // Show PIP
        if (engine.faceCapture && engine.faceCapture.videoElement) {
          camVideo.srcObject = engine.faceCapture.videoElement.srcObject;
          camPip.style.display = 'block';
        }

        // Error callback — auto-recover UI if camera dies
        engine.faceCapture.onError = (msg) => {
          log('カメラエラー: ' + msg, 'e');
          camActive = false;
          btnCam.classList.remove('active');
          btnCam.textContent = '📷 カメラを有効化';
          camPip.style.display = 'none';
          camVideo.srcObject = null;
          log('音声フォールバックに切替', 'w');
        };
      } else {
        btnCam.textContent = '📷 カメラを有効化';
        log('カメラ初期化失敗 — 音声フォールバック使用', 'w');
      }
    } else {
      engine.stopCamera();
      camActive = false;
      btnCam.classList.remove('active');
      btnCam.textContent = '📷 カメラを有効化';
      camPip.style.display = 'none';
      camVideo.srcObject = null;
      log('カメラ停止', 'i');
    }
  });

  // ---- Virtual Camera toggle ----
  let vcamActive = false;
  btnVcam.addEventListener('click', () => {
    if (!vcamActive) {
      const stream = engine.getStream(30);
      // Store for potential use with external tools
      window._avatarStream = stream;
      vcamActive = true;
      btnVcam.classList.add('active');
      btnVcam.textContent = '🖥️ 仮想カメラ ON';
      log('仮想カメラ ストリーム開始 (30fps)', 's');
    } else {
      vcamActive = false;
      btnVcam.classList.remove('active');
      btnVcam.textContent = '🖥️ 仮想カメラ ON';
      window._avatarStream = null;
      log('仮想カメラ停止', 'i');
    }
  });

  // ---- Settings toggles ----
  togGlasses.addEventListener('change', () => {
    engine.hasGlasses = togGlasses.checked;
    log(`メガネ保護: ${togGlasses.checked ? 'ON' : 'OFF'}`, 'i');
  });
  togBlink.addEventListener('change', () => {
    engine.idle.settings.blink = togBlink.checked;
  });
  togBreath.addEventListener('change', () => {
    engine.idle.settings.breath = togBreath.checked;
  });
  togMicro.addEventListener('change', () => {
    engine.idle.settings.micro = togMicro.checked;
  });

  // ---- Audio visualizer ----
  let vizBars = [];
  function setupVisualizer() {
    if (!vizWrap || vizBars.length > 0) return;
    for (let i = 0; i < 32; i++) {
      const bar = document.createElement('div');
      bar.className = 'vb';
      vizWrap.appendChild(bar);
      vizBars.push(bar);
    }
    updateViz();
  }

  function updateViz() {
    if (!micActive || !engine.audio.analyser) {
      requestAnimationFrame(updateViz);
      return;
    }
    const analyser = engine.audio.analyser;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);

    const step = Math.floor(data.length / vizBars.length);
    for (let i = 0; i < vizBars.length; i++) {
      const val = data[i * step] / 255;
      vizBars[i].style.height = `${Math.max(2, val * 44)}px`;
    }
    requestAnimationFrame(updateViz);
  }

  // ---- Status / debug callbacks ----
  engine.onFPS = (fps) => {
    if (sFPS) sFPS.textContent = `FPS:${fps}`;
  };

  engine.onEmotion = (em) => {
    if (sEmo) sEmo.textContent = `Em:${em.emotion}(${em.intensity.toFixed(2)})`;
  };

  engine.onBlendShapes = (bs) => {
    // BlendShape count
    const count = Object.keys(bs).filter(k => !k.startsWith('_')).length;
    if (sBS) sBS.textContent = `BS:${count}`;

    // jawOpen value
    const jaw = bs.jawOpen || 0;
    if (sJawOpen) sJawOpen.textContent = `Jaw:${jaw.toFixed(2)}`;

    // Debug bars
    if (barJaw) barJaw.style.width = `${(jaw) * 100}%`;
    if (barBlink) {
      const blink = Math.max(bs.eyeBlinkLeft || 0, bs.eyeBlinkRight || 0);
      barBlink.style.width = `${blink * 100}%`;
    }
    if (barSmile) {
      const smile = Math.max(bs.mouthSmileLeft || 0, bs.mouthSmileRight || 0);
      barSmile.style.width = `${smile * 100}%`;
    }
  };

  // ---- Initial state ----
  log('Avatar Meeting Studio v4 — WebGL2 + MediaPipe BlendShape', 'i');
  log('顔写真をアップロードしてください', 'i');
});
