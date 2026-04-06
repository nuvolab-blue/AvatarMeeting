# Avatar Meeting Studio v2

## システム概要

顔写真からVFXグレードのリアルタイムアバターを生成し、
Google Meet / Slack ハドルの仮想カメラとして使用するWebアプリ。

## v2 の特徴（v1からの改善）

- **ブラウザ完結型** — MuseTalk不要で動作
- **リップシンク遅延 < 16ms** — v1の300-800msから大幅改善
- **メガネフレーム保護** — 剛体構造の歪み防止
- **音声特徴量ベースのリアルタイム感情分析** — テキスト化不要
- **Perlin Noise による自然な微細表情** — まばたき・呼吸・微動

## アーキテクチャ

```
マイク → Web Audio FFT → AudioAnalyzer
  ├─ Viseme生成（口形素）     ← <16ms
  └─ 音声感情推定              ← テキスト化不要
      ↓
FaceRegionDeformer（9リージョン別変形）
  ├─ 口: jawOpen, lipStretch, lipPucker
  ├─ 眉: browRaise, browFurrow（メガネ保護付き）
  ├─ 目: eyeOpen（メガネ時はオーバーレイ方式）
  ├─ 頬: mouthCorner → 笑いジワ
  └─ 頭部: yaw, pitch, roll（Perlin noise + カメラ追跡）
      ↓
Canvas → 仮想カメラ → Meet/Slack
```

## 動作要件

- macOS / Chrome 最新版
- マイク・カメラの使用許可
- HTTPS（マイク・カメラアクセスに必要）

## クイックスタート

```bash
git clone <repo>
cd avatar-meeting-v2
chmod +x setup.sh start.sh
./setup.sh
./start.sh --frontend-only
# ブラウザで https://localhost:8443 を開く
```

## 使い方

1. 顔写真をアップロード（メガネ自動検出）
2. 「マイクを有効化」→ リップシンク + 感情分析が即座に開始
3. 「カメラを有効化」→ 頭部追跡（任意）
4. 「仮想カメラ ON」→ Meet/Slackでの使用

## Meet/Slack での使い方

1. 仮想カメラを ON にする
2. Google Meet / Slack ハドルを開く
3. カメラ設定から「Avatar Camera」を選択
4. LIVE バッジが表示されていることを確認

## 設定項目

| 設定 | 説明 |
|------|------|
| まばたき | 2-6秒間隔の自然なまばたき（20%で二重まばたき） |
| 呼吸 | 0.75Hz の呼吸アニメーション |
| マイクロ表情 | Perlin Noise による微細な表情変化・頭部揺動 |
| メガネ保護 | メガネ検出時に目周辺の変形を抑制 |

## トラブルシューティング

| 症状 | 原因 | 解決策 |
|------|------|--------|
| マイクが使えない | HTTPS未設定 | `./setup.sh` で証明書生成 |
| 口が動かない | マイク未許可 | ブラウザの権限設定を確認 |
| メガネが歪む | メガネ保護 OFF | 設定の「メガネ保護」を ON に |
| 動きが硬い | マイクロ表情 OFF | 設定の「マイクロ表情」を ON に |
| FPSが低い | 画像が大きすぎる | 640px以下の画像を使用 |

## VFX パラメータチューニング

主要パラメータは各JSクラス内で定数として定義されています:

- `audio-analyzer.js`: energy係数(×5.0), Viseme補間速度(0.40)
- `face-region-deformer.js`: リージョンrigidity, まばたき間隔(2-6s), 呼吸振幅(0.012)
- `face-engine.js`: 感情スムージング(0.88/0.12), 頭部姿勢スムージング(0.12)
