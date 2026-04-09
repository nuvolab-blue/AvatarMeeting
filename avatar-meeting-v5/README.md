# Avatar Meeting Studio v5

## 概要

Web カメラの表情を 3D アバター (Ready Player Me) にリアルタイム同期し、仮想カメラとして Meet/Slack で利用できる Web アプリ。

**v1-v4 との違い:** 2D 写真のピクセル変形を完全に廃止。代わりに Three.js で 3D アバターを表示し、MediaPipe の 52 ARKit BlendShape で表情を直接駆動する。

## 動作環境

- macOS 26.3 以降
- Chrome 最新版 (WebGL2 + WebGPU 対応)
- Web カメラ
- インターネット接続 (MediaPipe モデル + Three.js CDN ロード用)

## クイックスタート

```bash
chmod +x serve.sh
./serve.sh
```

ブラウザで http://localhost:8000/frontend/ を開く

## 使い方

### ステップ 1: 自分のアバターを作成

1. https://readyplayer.me/avatar?bodyType=halfbody にアクセス
2. 自撮り写真をアップロード or 顔のパーツを手動でカスタマイズ
3. 完成したら「Next」→「Done」
4. 出てきた URL (`https://models.readyplayer.me/xxxxx.glb`) をコピー

### ステップ 2: アバターをロード

- アプリの「アバター」欄に URL を貼り付け
- 「アバターをロード」ボタンを押す
- (デフォルトのデモアバターは自動ロードされる)

### ステップ 3: カメラを有効化

- 「カメラを有効化」ボタンを押す
- ブラウザのカメラ許可を承認
- 初回は MediaPipe モデル (~5MB) をダウンロード

### ステップ 4: Meet/Slack で使う

ブラウザ単独では仮想カメラとして OS に登録できないため、**OBS Studio + OBS Virtual Camera** を経由する:

1. https://obsproject.com/ から OBS Studio をインストール
2. OBS で「ソース追加」→「ウィンドウキャプチャ」→ Chrome ウィンドウを選択
3. 必要に応じてアバター部分だけクロップ
4. 右下の「仮想カメラ開始」をクリック
5. Google Meet / Slack のカメラ設定で「OBS Virtual Camera」を選択

## 設定

| 設定 | 説明 |
|------|------|
| 表情のスムージング | 0=即応 (機敏だが震えやすい), 1=固定 (安定だが鈍い) |
| 頭部追従の強さ | 0.5=控えめ, 1.0=自然, 1.5=誇張 |
| ミラー表示 | 自撮りカメラなのでデフォルト ON |

## トラブルシューティング

| 症状 | 原因と対処 |
|------|-----------|
| アバターがロードされない | URL に `?morphTargets=ARKit` が必要 (自動付与される) |
| 表情が動かない | カメラ許可を確認、MediaPipe が GPU delegate でロード済みか確認 |
| 表情が左右逆 | 「ミラー表示」チェックボックスを切り替え |
| FPS が低い | Chrome の GPU 加速を確認 (`chrome://gpu`) |
| 顔が検出されない | 明るい環境で、カメラに正面を向く |

## よりリアルなアバターを使う

v8 からローカル GLB ファイルのアップロードに対応しました。
以下のプラットフォームで作成したモデルを使用できます。

### 必須条件
- **ARKit 52 ブレンドシェイプが含まれていること**(顔追跡に必要)
- **Humanoid スケルトン**(Mixamo 互換が理想)(腕追跡に必要)

### 推奨プラットフォーム

| サービス | リアリズム | 無料 | ARKit BS | 備考 |
|---------|-----------|------|----------|------|
| Avaturn (T2)    | ★★★   | ✅   | ✅       | 現在使用中。最も手軽 |
| Didimo          | ★★★★  | 制限あり | ✅   | 写真から 2 分で生成、より写実的 |
| Character Creator 4 | ★★★★★ | ❌ | ✅ (要プラグイン) | 最高品質、Reallusion 製 |
| Meshcapade      | ★★★★  | 制限あり | △     | SMPL-X ベース、要カスタム設定 |
| Blender + FaceIt | ★★★★★ | ✅   | ✅       | 自前リギング、最大自由度 |

### 推奨ワークフロー(最も写実的)

1. **Character Creator 4 Essentials**(有料、$99〜)で男性モデル作成
2. 「Export to GLB」プラグインで ARKit ブレンドシェイプ付き GLB を出力
3. このアプリの「GLB ファイルを選択」または drag-drop で読み込み

### Avaturn 内でよりリアルに見せるコツ

1. T2 ボディタイプを選ぶ(必須)
2. カスタマイズ画面で肌のディテールを上げる
3. 髪型はできるだけ実写的なスタイルを選ぶ
4. ライティングを「夕焼け」プリセットにすると肌が温かく見える

### 背景 VFX の使い方

プリセット HDRI から選ぶか、ローカル画像/動画をアップロードできます。
動画背景を使う場合、MP4(H.264)か WebM が確実に動作します。
解像度は 1080p 以下を推奨。

## アーキテクチャ

```
[Web Camera]
  |
[MediaPipe Face Landmarker (WebGPU/Metal)]
  | 52 ARKit blendshapes + 4x4 transform matrix
[Three.js scene]
  | avatar.morphTargetInfluences[i] = score
  | headBone.rotation.set(...)
[WebGL render -> Canvas]
  |
[canvas.captureStream(30) -> window._avatarStream]
  |
[OBS Window Capture -> OBS Virtual Camera]
  |
[Google Meet / Slack]
```

## ファイル構成

```
frontend/
  index.html           # importmap + UI
  css/style.css        # Dark theme
  js/
    face-tracker.js    # MediaPipe Face Landmarker wrapper
    pose-tracker.js    # MediaPipe Pose Landmarker wrapper
    avatar-scene.js    # Three.js scene + VFX + background system
    idle-gesture.js    # Body animation (noise + arm retargeting)
    virtual-camera.js  # captureStream
    app.js             # Main loop + UI controller
```

## 技術スタック

- **Three.js 0.160.0** — 3D レンダリング (WebGL2)
- **MediaPipe Tasks Vision 0.10.18** — 顔追跡 (52 BlendShape + 頭部姿勢)
- **Ready Player Me** — 3D アバター (glTF + ARKit morph targets)
- **ES Modules + importmap** — バンドラー不要
