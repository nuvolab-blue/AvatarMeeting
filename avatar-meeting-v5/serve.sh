#!/bin/bash
cd "$(dirname "$0")"
echo "Avatar Meeting Studio v5"
echo "→ http://localhost:8000/frontend/"
python3 -m http.server 8000
