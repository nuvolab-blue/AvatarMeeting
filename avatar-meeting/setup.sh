#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
CERT_DIR="$BACKEND_DIR/certs"

echo "========================================="
echo "  Avatar Meeting Studio — セットアップ"
echo "========================================="
echo ""

# ---- 1. HTTPS証明書 ----
echo "[1/4] HTTPS証明書の準備..."
mkdir -p "$CERT_DIR"

if [ -f "$CERT_DIR/cert.pem" ] && [ -f "$CERT_DIR/key.pem" ]; then
  echo "  証明書は既に存在します。スキップ。"
elif command -v mkcert &>/dev/null; then
  echo "  mkcert で証明書を生成中..."
  mkcert -key-file "$CERT_DIR/key.pem" -cert-file "$CERT_DIR/cert.pem" \
    localhost 127.0.0.1 ::1
  echo "  証明書を生成しました: $CERT_DIR/"
else
  echo "  mkcert が見つかりません。openssl で自己署名証明書を生成します..."
  openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$CERT_DIR/key.pem" \
    -out "$CERT_DIR/cert.pem" \
    -days 365 \
    -subj "/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1" \
    2>/dev/null
  echo "  自己署名証明書を生成しました: $CERT_DIR/"
  echo "  ※ ブラウザで警告が出た場合は「詳細」→「このまま進む」で続行してください。"
  echo "  ※ より良い体験のために mkcert のインストールを推奨します:"
  echo "     brew install mkcert && mkcert -install"
fi

# ---- 2. Python仮想環境 ----
echo ""
echo "[2/4] Python仮想環境の作成..."
VENV_DIR="$BACKEND_DIR/.venv"
if [ ! -d "$VENV_DIR" ]; then
  python3 -m venv "$VENV_DIR"
  echo "  仮想環境を作成しました: $VENV_DIR"
else
  echo "  仮想環境は既に存在します。スキップ。"
fi

echo "  依存パッケージをインストール中..."
"$VENV_DIR/bin/pip" install --quiet --upgrade pip
"$VENV_DIR/bin/pip" install --quiet -r "$BACKEND_DIR/requirements.txt"
echo "  インストール完了。"

# ---- 3. .env ファイル ----
echo ""
echo "[3/4] 環境設定ファイルの確認..."
if [ ! -f "$SCRIPT_DIR/.env" ]; then
  cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
  echo "  .env を作成しました。必要に応じて編集してください。"
else
  echo "  .env は既に存在します。スキップ。"
fi

# ---- 4. MuseTalk ----
echo ""
echo "[4/4] MuseTalk の確認..."
echo ""
echo "  MuseTalk は別途インストールが必要です。"
echo "  インストール手順:"
echo "    1. git clone https://github.com/TMElyralab/MuseTalk.git"
echo "    2. cd MuseTalk && pip install -r requirements.txt"
echo "    3. モデルをダウンロード（README参照）"
echo "    4. python -m musetalk.server --port 8002 で起動"
echo ""

# ---- 完了 ----
echo "========================================="
echo "  セットアップ完了!"
echo ""
echo "  起動方法: ./start.sh"
echo "  URL: https://localhost:8443"
echo "========================================="
