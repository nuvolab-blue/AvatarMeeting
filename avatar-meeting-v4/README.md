# Avatar Meeting Studio v4

## v4 の技術革新（v3からの全面刷新）

### WebGL2 GPU レンダリング
- **1回の draw call** で20x24メッシュ全体を描画（v3: Canvas 2D × 480回）
- macOS Metal バックエンド経由でGPU直結処理
- 安定60fps（v3: 20-35fps）

### MediaPipe Face Landmarker BlendShape
- **52個のBlendShape係数** をカメラからリアルタイム取得
- 実際の口の動き・瞬き・眉・笑顔を直接読み取り
- v3の「音声FFT → 口の大きさ推定」という不正確な近似を廃止

### v1-v3 との比較

| 項目 | v1-v3 | v4 |
|------|-------|-----|
| 描画 | Canvas 2D (CPU) | WebGL2 (GPU) |
| 顔追跡 | FaceDetector API (bbox) / 音声FFT | MediaPipe BlendShape (52係数) |
| 口の動き | 音声の大きさから推定 | カメラで直接読み取り |
| FPS | 20-35 | 60 |
| draw call | 480/frame | 1/frame |

## システム要件

- macOS 13+ / Windows 10+ / Linux
- Chrome 最新版（WebGL2 + MediaPipe対応）
- カメラ（BlendShape用）
- マイク（音声感情分析用、オプション）

## クイックスタート

```bash
cd avatar-meeting-v4

# HTTP mode (最も簡単 — localhost限定)
./start.sh --http
# http://localhost:8091

# HTTPS mode (推奨 — 外部アクセス可)
./setup.sh
./start.sh --frontend-only
# https://localhost:8443
```

## 使い方

1. 顔写真をアップロード → WebGL2で描画、自動まばたき・呼吸開始
2. 「カメラを有効化」→ MediaPipeモデルDL（初回~4MB）→ BlendShapeリアルタイム反映
3. 「マイクを有効化」→ 音声感情分析（カメラ使用時はラベル表示のみ）
4. 「仮想カメラ ON」→ Meet/Slackで使用

## Meet/Slack での使い方

1. OBS Virtual Camera をインストール
2. 「仮想カメラ ON」でストリーム開始
3. OBS → ブラウザソースに `http://localhost:8091` を指定
4. OBS → 仮想カメラを開始
5. Meet/Slack のカメラ設定で「OBS Virtual Camera」を選択

## トラブルシューティング

### 「モデルダウンロード中」が終わらない
- インターネット接続を確認
- CDN (`cdn.jsdelivr.net`) へのアクセスを確認

### FPSが低い
- `chrome://gpu` でハードウェアアクセラレーションが有効か確認
- WebGL2が「Hardware accelerated」になっていること

### メガネが歪む
- 設定で「メガネ保護」をONに
- メガネゾーン（鼻梁～こめかみ）の変位が95%減衰される

### 顔が追随しない
- カメラ権限を確認（アドレスバーのカメラアイコン）
- MediaPipeモデルが正しくロードされたかログを確認
- BlendShapeデバッグバー（Jaw/Blink/Smile）が反応するか確認

### WebGL2エラー
- ブラウザがWebGL2対応か確認: `chrome://gpu`
- グラフィックドライバを最新版に更新
