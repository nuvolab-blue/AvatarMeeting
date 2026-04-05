"""MuseTalk server client — communicates with MuseTalk inference server (:8002).

Includes circuit-breaker logic: after consecutive failures, stops retrying
for a cooldown period to avoid log spam and wasted resources.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import time
from typing import Optional

import httpx

logger = logging.getLogger("uvicorn.error")

_DEFAULT_URL = "http://localhost:8002"
_PREPARE_TIMEOUT = 30.0
_INFER_TIMEOUT = 10.0
_MAX_RETRIES = 2

# Circuit breaker settings
_CB_FAILURE_THRESHOLD = 3   # open circuit after N consecutive failures
_CB_COOLDOWN_SECONDS = 60   # wait this long before retrying


class MuseTalkClient:
    """Async HTTP client for MuseTalk with circuit-breaker."""

    def __init__(self, base_url: str = _DEFAULT_URL) -> None:
        self._base_url = base_url.rstrip("/")
        self._client: Optional[httpx.AsyncClient] = None

        # Circuit breaker state
        self._consecutive_failures = 0
        self._circuit_open_until = 0.0  # Unix timestamp
        self._circuit_logged = False

    async def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(base_url=self._base_url)
        return self._client

    async def close(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    def _is_circuit_open(self) -> bool:
        """Return True if circuit breaker is open (skip requests)."""
        if self._consecutive_failures < _CB_FAILURE_THRESHOLD:
            return False
        now = time.time()
        if now < self._circuit_open_until:
            if not self._circuit_logged:
                logger.info(
                    "MuseTalk circuit breaker OPEN — skipping requests for %ds",
                    int(self._circuit_open_until - now),
                )
                self._circuit_logged = True
            return True
        # Cooldown expired — allow one retry
        self._circuit_logged = False
        return False

    def _record_success(self) -> None:
        self._consecutive_failures = 0
        self._circuit_logged = False

    def _record_failure(self) -> None:
        self._consecutive_failures += 1
        if self._consecutive_failures >= _CB_FAILURE_THRESHOLD:
            self._circuit_open_until = time.time() + _CB_COOLDOWN_SECONDS
            logger.warning(
                "MuseTalk circuit breaker tripped after %d failures — "
                "pausing for %ds",
                self._consecutive_failures,
                _CB_COOLDOWN_SECONDS,
            )

    async def health_check(self) -> bool:
        """Return True if MuseTalk server is reachable."""
        try:
            client = await self._ensure_client()
            resp = await client.get("/health", timeout=5.0)
            if resp.status_code == 200:
                self._record_success()
                return True
            return False
        except Exception:
            return False

    async def prepare(self, image_path: str, bbox_shift: int = 5) -> dict:
        """Send image for preprocessing."""
        if self._is_circuit_open():
            raise ConnectionError("MuseTalk circuit breaker open")
        payload = {"image_path": image_path, "bbox_shift": bbox_shift}
        return await self._post_with_retry("/prepare", payload, timeout=_PREPARE_TIMEOUT)

    async def infer(self, audio_pcm: bytes, avatar_id: str, fps: int = 25) -> list[bytes]:
        """Run lip-sync inference. Returns empty list on failure."""
        if self._is_circuit_open():
            return []
        audio_b64 = base64.b64encode(audio_pcm).decode("ascii")
        payload = {"audio": audio_b64, "avatar_id": avatar_id, "fps": fps}
        try:
            data = await self._post_with_retry("/infer", payload, timeout=_INFER_TIMEOUT)
            frames_b64: list[str] = data.get("frames", [])
            self._record_success()
            return [base64.b64decode(f) for f in frames_b64]
        except Exception as exc:
            self._record_failure()
            logger.warning("MuseTalk infer failed: %s", exc)
            return []

    async def _post_with_retry(self, path: str, json_body: dict, *, timeout: float) -> dict:
        """POST with retry (up to _MAX_RETRIES). Short backoff."""
        client = await self._ensure_client()
        last_exc: Exception | None = None
        for attempt in range(_MAX_RETRIES):
            try:
                resp = await client.post(path, json=json_body, timeout=timeout)
                resp.raise_for_status()
                self._record_success()
                return resp.json()
            except Exception as exc:
                last_exc = exc
                if attempt < _MAX_RETRIES - 1:
                    wait = min(2 ** attempt, 4)
                    logger.warning(
                        "MuseTalk %s attempt %d/%d failed (%s), retry in %ds",
                        path, attempt + 1, _MAX_RETRIES, exc, wait,
                    )
                    await asyncio.sleep(wait)
        self._record_failure()
        raise ConnectionError(
            f"MuseTalk {path} failed after {_MAX_RETRIES} retries"
        ) from last_exc
