"""MuseTalk server client — communicates with MuseTalk inference server (:8002)."""

from __future__ import annotations

import asyncio
import base64
import logging
from typing import Optional

import httpx

logger = logging.getLogger("uvicorn.error")

_DEFAULT_URL = "http://localhost:8002"
_PREPARE_TIMEOUT = 30.0
_INFER_TIMEOUT = 10.0
_MAX_RETRIES = 3


class MuseTalkClient:
    """Async HTTP client for MuseTalk preprocessing and inference."""

    def __init__(self, base_url: str = _DEFAULT_URL) -> None:
        self._base_url = base_url.rstrip("/")
        self._client: Optional[httpx.AsyncClient] = None

    async def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(base_url=self._base_url)
        return self._client

    async def close(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    async def health_check(self) -> bool:
        """Return True if MuseTalk server is reachable."""
        try:
            client = await self._ensure_client()
            resp = await client.get("/health", timeout=5.0)
            return resp.status_code == 200
        except Exception:
            return False

    async def prepare(self, image_path: str, bbox_shift: int = 5) -> dict:
        """Send image for preprocessing. Returns latents & face_mask (base64).

        Args:
            image_path: Path to the avatar source image.
            bbox_shift: Bounding-box pixel shift for face crop.

        Returns:
            dict with keys ``latents`` and ``face_mask`` (base64-encoded).
        """
        payload = {"image_path": image_path, "bbox_shift": bbox_shift}
        return await self._post_with_retry("/prepare", payload, timeout=_PREPARE_TIMEOUT)

    async def infer(self, audio_pcm: bytes, avatar_id: str, fps: int = 25) -> list[bytes]:
        """Run lip-sync inference and return a list of JPEG frame bytes.

        Args:
            audio_pcm: Raw PCM-16 mono 16 kHz audio bytes.
            avatar_id: Identifier returned by :meth:`prepare`.
            fps: Target frame rate.

        Returns:
            List of JPEG-encoded frame bytes. Empty list on failure.
        """
        audio_b64 = base64.b64encode(audio_pcm).decode("ascii")
        payload = {"audio": audio_b64, "avatar_id": avatar_id, "fps": fps}
        try:
            data = await self._post_with_retry("/infer", payload, timeout=_INFER_TIMEOUT)
            frames_b64: list[str] = data.get("frames", [])
            return [base64.b64decode(f) for f in frames_b64]
        except Exception as exc:
            logger.warning("MuseTalk infer failed, returning empty frames: %s", exc)
            return []

    async def _post_with_retry(self, path: str, json_body: dict, *, timeout: float) -> dict:
        """POST with exponential-backoff retry (up to *_MAX_RETRIES* attempts)."""
        client = await self._ensure_client()
        last_exc: Exception | None = None
        for attempt in range(_MAX_RETRIES):
            try:
                resp = await client.post(path, json=json_body, timeout=timeout)
                resp.raise_for_status()
                return resp.json()
            except Exception as exc:
                last_exc = exc
                wait = min(2 ** attempt, 8)
                logger.warning(
                    "MuseTalk %s attempt %d failed (%s), retrying in %ds",
                    path, attempt + 1, exc, wait,
                )
                await asyncio.sleep(wait)
        raise ConnectionError(f"MuseTalk {path} failed after {_MAX_RETRIES} retries") from last_exc
