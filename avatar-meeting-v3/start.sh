#!/bin/bash

cd "$(dirname "$0")"

# Activate venv
if [ -f "backend/venv/bin/activate" ]; then
    source backend/venv/bin/activate
else
    echo "Error: Virtual environment not found. Run ./setup.sh first."
    exit 1
fi

# Check for certs
if [ ! -f "backend/certs/cert.pem" ] || [ ! -f "backend/certs/key.pem" ]; then
    echo "Error: SSL certificates not found. Run ./setup.sh first."
    exit 1
fi

# Frontend-only mode
if [ "$1" = "--frontend-only" ]; then
    echo "Starting in frontend-only mode..."
    echo "Open: https://localhost:8443"
    cd backend
    uvicorn server:app --host 0.0.0.0 --port 8443 \
        --ssl-keyfile certs/key.pem --ssl-certfile certs/cert.pem
    exit 0
fi

# Full mode (MuseTalk + FastAPI)
MUSE_PID=""

# Start MuseTalk if available
if [ -d "../../MuseTalk" ]; then
    echo "Starting MuseTalk server..."
    cd ../../MuseTalk
    python musetalk_server.py --port 8002 --bbox_shift 5 &
    MUSE_PID=$!
    cd - > /dev/null
    sleep 2
fi

echo "Starting FastAPI server..."
echo "Open: https://localhost:8443"
cd backend
uvicorn server:app --host 0.0.0.0 --port 8443 \
    --ssl-keyfile certs/key.pem --ssl-certfile certs/cert.pem

# Cleanup
if [ -n "$MUSE_PID" ]; then
    echo "Stopping MuseTalk..."
    kill $MUSE_PID 2>/dev/null
fi
