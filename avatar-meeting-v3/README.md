# Avatar Meeting Studio v3

## v3 の変更点（v2からの改善）

- **Grid Mesh Warp方式** — 20x24メッシュによる継ぎ目のない顔変形
- **自然な口の開き方** — Gaussian変位で唇が広がりながら下顎が下がる＋歯テクスチャ
- **確実なまばたき** — 元画像のまぶた上部ピクセルをサンプリングして下に引き延ばし
- **メガネゾーン保護** — 変位禁止領域で眉が動いてもフレーム不変
- **MediaPipe不要** — FaceDetector API + 輝度重心フォールバック

## クイックスタート

```bash
cd avatar-meeting-v3
./setup.sh
./start.sh --frontend-only
# https://localhost:8443
```

## 使い方

1. 顔写真をアップロード → 自動でまばたき・呼吸・微動が開始
2. 「マイクを有効化」→ リップシンク + 感情分析
3. 「カメラを有効化」→ 頭部追跡
4. 「仮想カメラ ON」→ Meet/Slackで使用
