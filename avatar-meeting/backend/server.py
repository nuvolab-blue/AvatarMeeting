"""FastAPI main server — HTTPS, REST API, and WebSocket for lip-sync avatar."""

from __future__ import annotations

import asyncio
import base64
import logging
import os
import time
from typing import Optional

from dotenv import load_dotenv
from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from avatar_prepare import (
    AvatarPrepareError,
    avatar_cache,
    generate_avatar_id,
    save_upload,
    validate_image,
)
from musetalk_client import MuseTalkClient

# ---------------------------------------------------------------------------
# Avatar image store — keeps image path per avatar_id for fallback frames
# ---------------------------------------------------------------------------
_avatar_images: dict[str, str] = {}  # avatar_id → image file path

load_dotenv()

logger = logging.getLogger("uvicorn.error")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
MUSETALK_URL = os.getenv("MUSETALK_URL", "http://localhost:8002")
BBOX_SHIFT = int(os.getenv("BBOX_SHIFT", "5"))

# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------
app = FastAPI(title="Avatar Meeting Server")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

musetalk = MuseTalkClient(MUSETALK_URL)

# ---------------------------------------------------------------------------
# WebSocket lock — prevents concurrent writes on the same connection
# ---------------------------------------------------------------------------
_ws_locks: dict[int, asyncio.Lock] = {}


def _get_ws_lock(ws: WebSocket) -> asyncio.Lock:
    ws_id = id(ws)
    if ws_id not in _ws_locks:
        _ws_locks[ws_id] = asyncio.Lock()
    return _ws_locks[ws_id]


async def safe_send_json(ws: WebSocket, payload: dict) -> None:
    """Send JSON over WebSocket with a per-connection lock."""
    lock = _get_ws_lock(ws)
    async with lock:
        await ws.send_json(payload)


async def safe_send_bytes(ws: WebSocket, data: bytes) -> None:
    """Send binary over WebSocket with a per-connection lock."""
    lock = _get_ws_lock(ws)
    async with lock:
        await ws.send_bytes(data)


# ---------------------------------------------------------------------------
# REST endpoints
# ---------------------------------------------------------------------------
@app.get("/health")
async def health():
    """Health-check endpoint."""
    mt_ok = await musetalk.health_check()
    return {"status": "ok", "musetalk": "connected" if mt_ok else "disconnected"}


@app.post("/api/prepare_avatar")
async def prepare_avatar(file: UploadFile = File(...)):
    """Upload a photo and run MuseTalk preprocessing.

    Returns ``{"status": "ready", "avatar_id": str}`` on success.
    """
    file_bytes = await file.read()

    # Validate
    try:
        validate_image(file_bytes, file.filename or "upload.jpg")
    except AvatarPrepareError as exc:
        return JSONResponse(status_code=400, content={"error": str(exc)})

    # Save to disk
    image_path = save_upload(file_bytes, file.filename or "upload.jpg")

    # Check cache
    cached = avatar_cache.get(image_path, BBOX_SHIFT)
    if cached:
        logger.info("Cache hit for avatar %s", cached["avatar_id"])
        return {"status": "ready", "avatar_id": cached["avatar_id"]}

    # MuseTalk preprocessing (optional — works without MuseTalk server)
    avatar_id = generate_avatar_id()
    _avatar_images[avatar_id] = image_path
    musetalk_ready = False
    try:
        data = await musetalk.prepare(image_path, BBOX_SHIFT)
        avatar_cache.put(image_path, BBOX_SHIFT, avatar_id, data)
        musetalk_ready = True
    except Exception as exc:
        logger.warning("MuseTalk prepare failed (avatar will show static): %s", exc)
        avatar_cache.put(image_path, BBOX_SHIFT, avatar_id, {})

    # Return EXIF-corrected image as base64 for immediate frontend display
    import base64 as _b64
    import io as _io
    from PIL import Image as _Image, ImageOps as _ImageOps

    pil_img = _Image.open(_io.BytesIO(file_bytes))
    pil_img = _ImageOps.exif_transpose(pil_img)  # Fix EXIF rotation
    pil_img = pil_img.convert("RGB")
    buf = _io.BytesIO()
    pil_img.save(buf, format="JPEG", quality=90)
    image_b64 = _b64.b64encode(buf.getvalue()).decode("ascii")

    return {
        "status": "ready",
        "avatar_id": avatar_id,
        "image": f"data:image/jpeg;base64,{image_b64}",
        "musetalk": musetalk_ready,
    }


# ---------------------------------------------------------------------------
# WebSocket — lip-sync streaming
# ---------------------------------------------------------------------------
@app.websocket("/ws/lipsync")
async def ws_lipsync(ws: WebSocket):
    """WebSocket endpoint for real-time lip-sync streaming.

    Protocol
    --------
    Client → Server:
        - Binary message: PCM-16 mono 16 kHz audio chunk
        - JSON ``{"type": "config", "avatar_id": str}`` to set active avatar

    Server → Client:
        - ``{"type": "audio", "chunk_id": int, "audio_b64": str, "wall_start_time": float}``
        - ``{"type": "frames", "chunk_id": int, "frames": [base64_jpeg, ...]}``
        - ``{"type": "done", "chunk_id": int}``
        - ``{"type": "error", "message": str}``
    """
    await ws.accept()
    ws_id = id(ws)
    logger.info("WebSocket connected (id=%d)", ws_id)

    avatar_id: Optional[str] = None
    chunk_counter = 0
    # Event to serialise chunk processing (audio-first guarantee)
    prev_audio_sent = asyncio.Event()
    prev_audio_sent.set()  # first chunk can start immediately
    tasks: list[asyncio.Task] = []

    try:
        while True:
            message = await ws.receive()

            # --- Text (JSON) messages ---
            if "text" in message:
                import json
                data = json.loads(message["text"])
                msg_type = data.get("type")

                if msg_type == "config":
                    avatar_id = data.get("avatar_id")
                    logger.info("Avatar set to %s", avatar_id)
                    await safe_send_json(ws, {"type": "config_ack", "avatar_id": avatar_id})

                elif msg_type == "ping":
                    await safe_send_json(ws, {"type": "pong"})

                continue

            # --- Binary messages (PCM audio) ---
            if "bytes" in message:
                audio_pcm: bytes = message["bytes"]
                if not avatar_id:
                    await safe_send_json(ws, {"type": "error", "message": "No avatar configured"})
                    continue

                chunk_counter += 1
                chunk_id = chunk_counter

                # Wait for previous chunk's audio to be sent first
                await prev_audio_sent.wait()
                current_audio_sent = asyncio.Event()
                prev_audio_sent = current_audio_sent

                # --- Audio-first: send audio to browser BEFORE inference ---
                audio_b64 = base64.b64encode(audio_pcm).decode("ascii")
                wall_start_time = time.time()
                await safe_send_json(ws, {
                    "type": "audio",
                    "chunk_id": chunk_id,
                    "audio_b64": audio_b64,
                    "wall_start_time": wall_start_time,
                })
                current_audio_sent.set()

                # --- MuseTalk inference (async) ---
                task = asyncio.create_task(
                    _process_lipsync(ws, audio_pcm, avatar_id, chunk_id)
                )
                tasks.append(task)

    except WebSocketDisconnect:
        logger.info("WebSocket disconnected (id=%d)", ws_id)
    except Exception as exc:
        logger.error("WebSocket error (id=%d): %s", ws_id, exc)
    finally:
        # Cleanup
        _ws_locks.pop(ws_id, None)
        for t in tasks:
            t.cancel()
        logger.info("WebSocket cleanup done (id=%d)", ws_id)


async def _process_lipsync(
    ws: WebSocket, audio_pcm: bytes, avatar_id: str, chunk_id: int
) -> None:
    """Run MuseTalk inference and stream frames back to the client.

    When MuseTalk is unavailable, sends ``done`` immediately so the frontend
    continues with its client-side lip-sync (audio amplitude → mouth deformation).
    """
    try:
        frames = await musetalk.infer(audio_pcm, avatar_id)

        if frames:
            frames_b64 = [base64.b64encode(f).decode("ascii") for f in frames]
            await safe_send_json(ws, {
                "type": "frames",
                "chunk_id": chunk_id,
                "frames": frames_b64,
            })

        # Always send done — frontend uses local lip-sync as fallback
        await safe_send_json(ws, {"type": "done", "chunk_id": chunk_id})
    except Exception as exc:
        logger.error("Lipsync processing error (chunk %d): %s", chunk_id, exc)
        try:
            await safe_send_json(ws, {"type": "done", "chunk_id": chunk_id})
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Static files (frontend) — mount AFTER API routes
# ---------------------------------------------------------------------------
_frontend_dir = os.path.join(os.path.dirname(__file__), "..", "frontend")
if os.path.isdir(_frontend_dir):
    app.mount("/", StaticFiles(directory=_frontend_dir, html=True), name="frontend")

# ---------------------------------------------------------------------------
# Startup / Shutdown
# ---------------------------------------------------------------------------
@app.on_event("startup")
async def _startup():
    ok = await musetalk.health_check()
    logger.info("MuseTalk server: %s", "connected" if ok else "NOT reachable")


@app.on_event("shutdown")
async def _shutdown():
    await musetalk.close()
