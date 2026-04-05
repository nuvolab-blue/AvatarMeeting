# Avatar Meeting Studio

リアルタイムリップシンクアバターを使って、Google Meet や Slack Huddle などの会議に参加できるシステムです。

## システム要件

- **OS**: macOS 13+ (Apple Silicon / Intel)
- **ブラウザ**: Google Chrome 最新版（Insertable Streams API 必須）
- **Python**: 3.11+
- **GPU**: NVIDIA GPU（MuseTalk推論用。CPU でも動作するが低速）
- **MuseTalk**: 別途インストールが必要

## アーキテクチャ

```
┌─────────────┐     PCM16      ┌──────────────┐    HTTP/WS     ┌──────────────┐
│  マイク      │ ──────────────→│  FastAPI      │───────────────→│  MuseTalk    │
│  カメラ      │                │  (:8443)      │←───────────────│  (:8002)     │
│  ブラウザ    │←───frames──────│              │   JPEG frames  │              │
└──────┬──────┘                └──────────────┘                └──────────────┘
       │
       ▼
  仮想カメラ → Meet / Slack
```

## セットアップ

### 1. MuseTalk のインストール

```bash
git clone https://github.com/TMElyralab/MuseTalk.git
cd MuseTalk
pip install -r requirements.txt
# モデルのダウンロード（README.md 参照）
```

### 2. Avatar Meeting Studio のセットアップ

```bash
cd avatar-meeting
chmod +x setup.sh start.sh
./setup.sh
```

`setup.sh` が以下を自動実行します:
- mkcert のインストールと HTTPS 証明書生成
- Python 仮想環境の作成と依存パッケージのインストール
- `.env` ファイルの生成

### 3. 環境設定（任意）

`.env` を編集して設定をカスタマイズ:

```env
MUSETALK_URL=http://localhost:8002
BBOX_SHIFT=5
SERVER_PORT=8443
LOG_LEVEL=info
```

## 起動手順

### MuseTalk サーバを起動（ターミナル 1）

```bash
cd /path/to/MuseTalk
python -m musetalk.server --port 8002
```

### Avatar Meeting Studio を起動（ターミナル 2）

```bash
cd avatar-meeting
./start.sh
```

ブラウザで **https://localhost:8443** を開きます。

## 使い方

1. **写真をアップロード** — 正面顔写真を選択
2. **マイクを有効化** — 音声キャプチャと感情分析を開始
3. **カメラを有効化** — 頭部追跡を開始
4. **仮想カメラ ON** — アバター映像を会議アプリに送信

### Google Meet での使い方

1. 仮想カメラを ON にする
2. Meet の設定 → カメラ → 「Avatar Camera」を選択
3. 会議に参加

### Slack Huddle での使い方

1. 仮想カメラを ON にする
2. Slack のビデオ設定 → カメラソースを変更
3. Huddle を開始

## トラブルシューティング

### マイクが使えない

- HTTPS でアクセスしていることを確認（`https://localhost:8443`）
- `http://` ではマイク・カメラ API が使えません
- Chrome の設定でマイクの許可を確認

### カメラが表示されない

- Chrome で Insertable Streams API が有効か確認
- `chrome://flags/#enable-experimental-web-platform-features` を有効に
- カメラの権限を許可

### リップシンクが遅い

- `BBOX_SHIFT` の値を調整（小さくすると高速だが精度低下）
- GPU が使用されていることを確認（`nvidia-smi`）
- MuseTalk サーバのログでボトルネックを確認

### 音声と映像がズレる

- AudioContext の sampleRate が 16000Hz であることを確認
- ブラウザのタブがバックグラウンドになっていないか確認
- ネットワーク遅延が大きい場合はローカル環境で実行

### MuseTalk に接続できない

- MuseTalk サーバが `:8002` で起動しているか確認
- `.env` の `MUSETALK_URL` が正しいか確認
- ファイアウォールの設定を確認

## ファイル構成

```
avatar-meeting/
├── backend/
│   ├── server.py            # FastAPI メインサーバ
│   ├── musetalk_client.py   # MuseTalk 通信クライアント
│   ├── avatar_prepare.py    # 画像前処理・キャッシュ
│   ├── requirements.txt
│   └── certs/               # HTTPS 証明書
├── frontend/
│   ├── index.html
│   ├── js/
│   │   ├── app.js           # メインアプリケーション
│   │   ├── audio.js          # AudioWorklet 音声キャプチャ
│   │   ├── whisper_stt.js    # 音声認識 (Web Speech API)
│   │   ├── face_tracker.js   # MediaPipe 顔追跡
│   │   ├── emotion.js        # 感情分析
│   │   ├── avatar_canvas.js  # Canvas 合成エンジン
│   │   ├── virtual_camera.js # 仮想カメラ
│   │   └── websocket.js      # WebSocket 通信
│   └── css/
│       └── style.css
├── setup.sh                  # セットアップスクリプト
├── start.sh                  # 起動スクリプト
├── .env.example
└── README.md
```

## ライセンス

MIT
