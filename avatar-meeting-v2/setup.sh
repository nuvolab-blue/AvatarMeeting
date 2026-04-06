#!/bin/bash
set -e

echo "=== Avatar Meeting Studio v2 Setup ==="

# Python virtual environment
if [ ! -d "backend/venv" ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv backend/venv
fi
source backend/venv/bin/activate
pip install -r backend/requirements.txt

# mkcert (for HTTPS)
if ! command -v mkcert &> /dev/null; then
    echo ""
    echo "mkcert not found. Install it with:"
    echo "  brew install mkcert"
    echo ""
    echo "Then run this script again."
    exit 1
fi

mkdir -p backend/certs
mkcert -install
cd backend/certs
mkcert localhost 127.0.0.1 ::1
mv localhost+2.pem cert.pem
mv localhost+2-key.pem key.pem
cd ../..

echo ""
echo "=== Setup complete ==="
echo ""
echo "Start the server:"
echo "  ./start.sh                  # Full mode (with MuseTalk if available)"
echo "  ./start.sh --frontend-only  # Frontend only (no MuseTalk needed)"
echo ""
echo "Then open: https://localhost:8443"
