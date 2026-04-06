#!/bin/bash
set -e

echo "=== Avatar Meeting Studio v4 Setup ==="

# Python virtual environment
if [ ! -d "backend/venv" ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv backend/venv
fi
source backend/venv/bin/activate
pip install -r backend/requirements.txt

# mkcert (for HTTPS — required for camera/mic)
if ! command -v mkcert &> /dev/null; then
    echo ""
    echo "mkcert not found. Install it with:"
    echo "  brew install mkcert"
    echo ""
    echo "Then run this script again."
    echo ""
    echo "Or use --http mode (localhost only):"
    echo "  ./start.sh --http"
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
echo "  ./start.sh                  # HTTPS mode (recommended)"
echo "  ./start.sh --http           # HTTP localhost (no mkcert needed)"
echo "  ./start.sh --frontend-only  # Frontend only via uvicorn"
echo ""
echo "Then open: https://localhost:8443"
