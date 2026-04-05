#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$SCRIPT_DIR/backend"
VENV_DIR="$BACKEND_DIR/.venv"
CERT_DIR="$BACKEND_DIR/certs"

# .env 読み込み
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a; source "$SCRIPT_DIR/.env"; set +a
fi

SERVER_PORT="${SERVER_PORT:-8443}"
LOG_LEVEL="${LOG_LEVEL:-info}"

echo "========================================="
echo "  Avatar Meeting Studio — 起動"
echo "========================================="
echo ""

# ---- 前提チェック ----
if [ ! -f "$CERT_DIR/cert.pem" ]; then
  echo "ERROR: HTTPS証明書が見つかりません。先に ./setup.sh を実行してください。"
  exit 1
fi

if [ ! -d "$VENV_DIR" ]; then
  echo "ERROR: Python仮想環境が見つかりません。先に ./setup.sh を実行してください。"
  exit 1
fi

# ---- MuseTalkサーバ起動（バックグラウンド） ----
echo "[1/2] MuseTalkサーバの起動..."
MUSETALK_URL="${MUSETALK_URL:-http://localhost:8002}"

# MuseTalkが既に起動しているか確認
if curl -s "${MUSETALK_URL}/health" >/dev/null 2>&1; then
  echo "  MuseTalkサーバは既に起動しています (${MUSETALK_URL})"
else
  echo "  MuseTalkサーバが見つかりません。"
  echo "  別ターミナルで MuseTalk を起動してください:"
  echo "    cd /path/to/MuseTalk"
  echo "    python -m musetalk.server --port 8002"
  echo ""
  echo "  MuseTalk なしでも起動します（リップシンクは無効）。"
fi

# ---- FastAPIサーバ起動 ----
echo ""
echo "[2/2] FastAPIサーバの起動..."
echo ""
echo "  URL: https://localhost:${SERVER_PORT}"
echo "  ログレベル: ${LOG_LEVEL}"
echo ""
echo "  停止するには Ctrl+C を押してください。"
echo "========================================="
echo ""

cd "$BACKEND_DIR"
exec "$VENV_DIR/bin/uvicorn" server:app \
  --host 0.0.0.0 \
  --port "$SERVER_PORT" \
  --ssl-keyfile "$CERT_DIR/key.pem" \
  --ssl-certfile "$CERT_DIR/cert.pem" \
  --log-level "$LOG_LEVEL"
