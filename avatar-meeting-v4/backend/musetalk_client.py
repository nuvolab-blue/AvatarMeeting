"""MuseTalk server client with circuit breaker.

After initial health check failure, disables ALL MuseTalk requests silently.
No retries, no log spam. Local VFX engine handles everything client-side.
"""

from __future__ import annotations

import base64
import logging
from typing import Optional

import httpx

logger = logging.getLogger("uvicorn.error")

_DEFAULT_URL = "http://localhost:8002"
_PREPARE_TIMEOUT = 30.0
_INFER_TIMEOUT = 10.0


class MuseTalkClient:
    """Async HTTP client for MuseTalk — disabled when server unreachable."""

    def __init__(self, base_url: str = _DEFAULT_URL) -> None:
        self._base_url = base_url.rstrip("/")
        self._client: Optional[httpx.AsyncClient] = None
        self._available = False
        self._checked = False

    async def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(base_url=self._base_url)
        return self._client

    async def close(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    async def health_check(self) -> bool:
        """Check if MuseTalk is reachable. Sets _available flag."""
        try:
            client = await self._ensure_client()
            resp = await client.get("/health", timeout=5.0)
            self._available = resp.status_code == 200
        except Exception:
            self._available = False
        self._checked = True
        if not self._available:
            logger.info("MuseTalk not available — VFX engine will handle everything")
        return self._available

    async def prepare(self, image_path: str, bbox_shift: int = 5) -> dict:
        """Send image for preprocessing. Raises ConnectionError if unavailable."""
        if not self._available:
            raise ConnectionError("MuseTalk not available")
        payload = {"image_path": image_path, "bbox_shift": bbox_shift}
        try:
            client = await self._ensure_client()
            resp = await client.post("/prepare", json=payload, timeout=_PREPARE_TIMEOUT)
            resp.raise_for_status()
            return resp.json()
        except Exception as exc:
            self._available = False
            logger.warning("MuseTalk prepare failed, disabling: %s", exc)
            raise

    async def infer(self, audio_pcm: bytes, avatar_id: str, fps: int = 25) -> list[bytes]:
        """Run lip-sync inference. Returns empty list silently if unavailable."""
        if not self._available:
            return []
        audio_b64 = base64.b64encode(audio_pcm).decode("ascii")
        payload = {"audio": audio_b64, "avatar_id": avatar_id, "fps": fps}
        try:
            client = await self._ensure_client()
            resp = await client.post("/infer", json=payload, timeout=_INFER_TIMEOUT)
            resp.raise_for_status()
            data = resp.json()
            frames_b64: list[str] = data.get("frames", [])
            return [base64.b64decode(f) for f in frames_b64]
        except Exception as exc:
            self._available = False
            logger.warning("MuseTalk infer failed, disabling: %s", exc)
            return []
