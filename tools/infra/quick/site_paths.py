"""Shared Quick path/id helpers with no third-party deps (used by server + client)."""

from __future__ import annotations

import mimetypes
import re
from pathlib import Path

_SITE_ID_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")

DEFAULT_BASE_DOMAIN = "quick.internal"
DEFAULT_LOCAL_ROOT = "/srv/quick-sites"
DEFAULT_INDEX = "index.html"
MANIFEST_DIR = "_quick"
MANIFEST_PATH = f"{MANIFEST_DIR}/manifest.json"

_CONTENT_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".mjs": "application/javascript; charset=utf-8",
    ".cjs": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".wasm": "application/wasm",
}


def content_type(path: str) -> str:
    """Best content type for a file path, biased toward web defaults."""
    ext = Path(path).suffix.lower()
    if ext in _CONTENT_TYPES:
        return _CONTENT_TYPES[ext]
    guessed, _ = mimetypes.guess_type(path)
    return guessed or "application/octet-stream"


def is_valid_site_id(site_id: str) -> bool:
    """Return whether ``site_id`` is a valid DNS label."""
    return bool(_SITE_ID_RE.match(site_id.strip().lower()))
