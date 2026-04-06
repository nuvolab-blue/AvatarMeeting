"""Avatar Meeting Studio v2 — FastAPI Backend.

Optional server for:
 - Serving frontend via HTTPS (required for mic/camera access)
 - MuseTalk hybrid mode (when MuseTalk server is available)
"""

from __future__ import annotations

import asyncio
import logging
import os
from pathlib import Path

from fastapi import FastAPI, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from musetalk_client import MuseTalkClient

logger = logging.getLogger("uvicorn.error")

app = FastAPI(title="Avatar Meeting Studio v2 Backend")

# MuseTalk client (optional hybrid mode)
_musetalk = MuseTalkClient(os.getenv("MUSETALK_URL", "http://localhost:8002"))
_ws_lock = asyncio.Lock()

# Avatar cache
_avatar_cache: dict[str, dict] = {}

# Upload directory
UPLOAD_DIR = Path("uploads")
UPLOAD_DIR.mkdir(exist_ok=True)


# ==========================================================================
# Health check
# ==========================================================================

@app.get("/health")
async def health() -> dict:
    """Health check — includes MuseTalk availability."""
    muse_ok = await _musetalk.health_check()
    return {
        "status": "ok",
        "musetalk_available": muse_ok,
        "mode": "hybrid" if muse_ok else "frontend-only",
    }


# ==========================================================================
# Avatar preparation (MuseTalk hybrid)
# ==========================================================================

@app.post("/api/prepare_avatar")
async def prepare_avatar(file: UploadFile) -> JSONResponse:
    """Upload avatar image and prepare for MuseTalk inference."""
    if not file.content_type or not file.content_type.startswith("image/"):
        return JSONResponse({"error": "Image file required"}, status_code=400)

    # Save file
    save_path = UPLOAD_DIR / file.filename
    content = await file.read()
    save_path.write_bytes(content)

    bbox_shift = int(os.getenv("BBOX_SHIFT", "5"))
    cache_key = f"{save_path}:{bbox_shift}"

    if cache_key in _avatar_cache:
        logger.info("Avatar already prepared (cached): %s", file.filename)
        return JSONResponse({"status": "ready", "cached": True, "avatar_id": file.filename})

    # Try MuseTalk prepare
    try:
        result = await _musetalk.prepare(str(save_path), bbox_shift)
        _avatar_cache[cache_key] = result
        logger.info("Avatar prepared via MuseTalk: %s", file.filename)
        return JSONResponse({"status": "ready", "cached": False, "avatar_id": file.filename})
    except ConnectionError:
        return JSONResponse({
            "status": "frontend-only",
            "message": "MuseTalk not available — using browser VFX engine",
        })
    except Exception as exc:
        logger.error("Prepare failed: %s", exc)
        return JSONResponse({"error": str(exc)}, status_code=500)


# ==========================================================================
# WebSocket lip-sync (MuseTalk hybrid)
# ==========================================================================

async def _safe_send(ws: WebSocket, data: bytes | str) -> None:
    """Thread-safe WebSocket send with lock."""
    async with _ws_lock:
        try:
            if isinstance(data, bytes):
                await ws.send_bytes(data)
            else:
                await ws.send_text(data)
        except Exception:
            pass


@app.websocket("/ws/lipsync")
async def ws_lipsync(ws: WebSocket) -> None:
    """WebSocket endpoint for real-time lip-sync (MuseTalk hybrid mode)."""
    await ws.accept()
    logger.info("WebSocket connected")

    try:
        while True:
            data = await ws.receive_bytes()

            # Echo audio back immediately (for client-side playback)
            await _safe_send(ws, data)

            # Run MuseTalk inference in background
            if _musetalk._available:
                asyncio.create_task(_infer_and_send(ws, data))

    except WebSocketDisconnect:
        logger.info("WebSocket disconnected")
    except Exception as exc:
        logger.error("WebSocket error: %s", exc)


async def _infer_and_send(ws: WebSocket, audio_pcm: bytes) -> None:
    """Run MuseTalk inference and send frames."""
    try:
        frames = await _musetalk.infer(audio_pcm, "default")
        if frames:
            import json
            import base64
            msg = json.dumps({
                "type": "frames",
                "frames": [base64.b64encode(f).decode() for f in frames],
            })
            await _safe_send(ws, msg)
    except Exception as exc:
        logger.warning("Infer failed: %s", exc)


# ==========================================================================
# Lifecycle
# ==========================================================================

@app.on_event("startup")
async def startup() -> None:
    """Check MuseTalk availability on startup."""
    ok = await _musetalk.health_check()
    mode = "hybrid (MuseTalk available)" if ok else "frontend-only"
    logger.info("Avatar Meeting Studio v2 started — mode: %s", mode)


@app.on_event("shutdown")
async def shutdown() -> None:
    """Cleanup."""
    await _musetalk.close()


# ==========================================================================
# Static files (serve frontend)
# ==========================================================================

_frontend_dir = Path(__file__).parent.parent / "frontend"
if _frontend_dir.exists():
    app.mount("/", StaticFiles(directory=str(_frontend_dir), html=True), name="frontend")
