"""Avatar photo preprocessing and cache management."""

from __future__ import annotations

import hashlib
import logging
import os
import shutil
import uuid
from pathlib import Path
from typing import Optional

from PIL import Image

logger = logging.getLogger("uvicorn.error")

UPLOAD_DIR = Path(__file__).parent / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)

ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
MAX_IMAGE_SIZE = 10 * 1024 * 1024  # 10 MB


class AvatarPrepareError(Exception):
    """Raised when avatar preparation fails."""


def _cache_key(image_path: str, bbox_shift: int) -> str:
    """Create a deterministic cache key from (image_path, bbox_shift)."""
    h = hashlib.sha256(f"{image_path}:{bbox_shift}".encode()).hexdigest()[:16]
    return h


class AvatarCache:
    """In-memory cache mapping (image_path, bbox_shift) → avatar_id + MuseTalk data."""

    def __init__(self) -> None:
        self._store: dict[str, dict] = {}  # cache_key → {avatar_id, data}

    def get(self, image_path: str, bbox_shift: int) -> Optional[dict]:
        key = _cache_key(image_path, bbox_shift)
        return self._store.get(key)

    def put(self, image_path: str, bbox_shift: int, avatar_id: str, data: dict) -> None:
        key = _cache_key(image_path, bbox_shift)
        self._store[key] = {"avatar_id": avatar_id, "data": data}
        logger.info("Cached avatar %s (key=%s)", avatar_id, key)

    def has(self, image_path: str, bbox_shift: int) -> bool:
        return _cache_key(image_path, bbox_shift) in self._store


avatar_cache = AvatarCache()


def validate_image(file_bytes: bytes, filename: str) -> None:
    """Validate uploaded image file format and size.

    Raises:
        AvatarPrepareError: If validation fails.
    """
    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise AvatarPrepareError(
            f"Unsupported format '{ext}'. Allowed: {', '.join(ALLOWED_EXTENSIONS)}"
        )
    if len(file_bytes) > MAX_IMAGE_SIZE:
        raise AvatarPrepareError(
            f"Image too large ({len(file_bytes)} bytes). Max: {MAX_IMAGE_SIZE} bytes"
        )
    try:
        img = Image.open(__import__("io").BytesIO(file_bytes))
        img.verify()
    except Exception as exc:
        raise AvatarPrepareError(f"Invalid image data: {exc}") from exc


def save_upload(file_bytes: bytes, filename: str) -> str:
    """Save uploaded image to disk and return the file path.

    Args:
        file_bytes: Raw image bytes.
        filename: Original filename (used for extension).

    Returns:
        Absolute path of the saved image.
    """
    ext = Path(filename).suffix.lower()
    unique_name = f"{uuid.uuid4().hex}{ext}"
    dest = UPLOAD_DIR / unique_name
    dest.write_bytes(file_bytes)
    logger.info("Saved upload to %s", dest)
    return str(dest)


def generate_avatar_id() -> str:
    """Generate a unique avatar identifier."""
    return uuid.uuid4().hex[:12]
