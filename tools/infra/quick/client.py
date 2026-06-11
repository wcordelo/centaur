"""Quick — zero-friction static-site deployment for Centaur agents.

Implements the "Quick" architecture: an agent generates a static web artifact
(HTML/JS/CSS) and finalizes it with a single ``deploy_artifact`` call. The tool
validates the requested slug, uploads each file under ``<site_id>/<path>`` with
the correct content type, and returns a live ``https://<site_id>.<domain>`` URL.

Two interchangeable backends are supported behind one interface:

- ``local`` (default): writes the artifact tree under ``QUICK_LOCAL_ROOT`` so the
  flow is fully exercisable on the local Centaur stack (served by an in-cluster
  static server / the dev ``http.server``). No cloud credentials required.
- ``s3``: PUTs each object to an S3-compatible bucket (AWS S3 or Cloudflare R2).
  Requests go out over ``httpx`` so iron-proxy can inject SigV4 credentials via
  the declared ``aws_auth`` secret — the agent never sees raw AWS keys.

The public interface mirrors the Notion SPEC ``deploy_artifact`` schema and adds
the lifecycle controls the Slack card exposes ([Re-generate]/[View Logs]/[Delete]).
"""

from __future__ import annotations

import mimetypes
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

from centaur_sdk import secret

# A site_id becomes a DNS label (``<site_id>.quick.internal``), so it must be a
# valid, lowercase DNS label: 1-63 chars, alphanumeric, internal hyphens only.
_SITE_ID_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")

DEFAULT_BASE_DOMAIN = "quick.internal"
DEFAULT_LOCAL_ROOT = "/srv/quick-sites"
DEFAULT_INDEX = "index.html"

# Guardrails to keep a single deploy bounded.
MAX_FILES = 500
MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_TOTAL_BYTES = 100 * 1024 * 1024

# Explicit content types for the web file types the Quick platform serves. These
# take priority over ``mimetypes`` so charset and JS module types stay correct.
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


class QuickDeployError(RuntimeError):
    """Raised when a deploy request is invalid or a backend upload fails."""


def _cfg(key: str, default: str) -> str:
    """Read a config value, tolerating the server-mode stub backend.

    In server mode ``secret()`` is backed by a stub that echoes the key name
    back as a placeholder when the value is unset (so credentials can be
    injected by the firewall). For plain config that means an unset key returns
    the key name itself, so treat that case as "use the default".
    """
    val = secret(key, default)
    return default if val == key else val


def _content_type(path: str) -> str:
    """Best content type for a file path, biased toward web defaults."""
    ext = Path(path).suffix.lower()
    if ext in _CONTENT_TYPES:
        return _CONTENT_TYPES[ext]
    guessed, _ = mimetypes.guess_type(path)
    return guessed or "application/octet-stream"


def _validate_site_id(site_id: str) -> str:
    site_id = (site_id or "").strip().lower()
    if not _SITE_ID_RE.match(site_id):
        raise QuickDeployError(
            f"invalid site_id {site_id!r}: must be 1-63 chars, lowercase letters,"
            " digits, and internal hyphens (a valid DNS label)."
        )
    return site_id


def _safe_relpath(raw_path: str) -> str:
    """Normalize a file path and reject anything that escapes the site root."""
    if not raw_path or not raw_path.strip():
        raise QuickDeployError("file path must not be empty.")
    candidate = raw_path.strip().replace("\\", "/").lstrip("/")
    parts: list[str] = []
    for part in candidate.split("/"):
        if part in ("", "."):
            continue
        if part == "..":
            raise QuickDeployError(f"file path {raw_path!r} must not contain '..'.")
        parts.append(part)
    if not parts:
        raise QuickDeployError(f"file path {raw_path!r} did not resolve to a file.")
    return "/".join(parts)


def _decode_content(content: str, encoding: str) -> bytes:
    if encoding == "base64":
        import base64

        try:
            return base64.b64decode(content, validate=True)
        except (ValueError, TypeError) as exc:
            raise QuickDeployError(f"invalid base64 content: {exc}") from exc
    if encoding in ("utf-8", "utf8", "text", ""):
        return content.encode("utf-8")
    raise QuickDeployError(f"unsupported encoding {encoding!r}: use 'utf-8' (default) or 'base64'.")


class QuickClient:
    """Deploy and manage static web artifacts on the Quick platform."""

    def __init__(
        self,
        *,
        backend: str | None = None,
        base_domain: str | None = None,
        local_root: str | None = None,
        s3_bucket: str | None = None,
        s3_endpoint: str | None = None,
        s3_region: str | None = None,
        public_base_url: str | None = None,
        timeout: float = 30.0,
    ) -> None:
        self.backend = (backend or _cfg("QUICK_DEPLOY_BACKEND", "local")).strip().lower()
        self.base_domain = (
            (base_domain or _cfg("QUICK_BASE_DOMAIN", DEFAULT_BASE_DOMAIN)).strip().strip(".")
        )
        self.local_root = Path(local_root or _cfg("QUICK_LOCAL_ROOT", DEFAULT_LOCAL_ROOT))
        self.s3_bucket = (s3_bucket or _cfg("QUICK_S3_BUCKET", "")).strip()
        self.s3_endpoint = (s3_endpoint or _cfg("QUICK_S3_ENDPOINT", "")).strip().rstrip("/")
        self.s3_region = (s3_region or _cfg("QUICK_S3_REGION", "auto")).strip()
        # Optional override when the public URL differs from <id>.<domain>.
        self.public_base_url = (
            (public_base_url or _cfg("QUICK_PUBLIC_BASE_URL", "")).strip().rstrip("/")
        )
        self.timeout = timeout
        self._http: httpx.Client | None = None

    # -- public tool methods --------------------------------------------------

    def deploy_artifact(self, site_id: str, files: list[dict[str, str]]) -> dict[str, Any]:
        """Deploy a static web artifact (HTML/JS/CSS) to the Quick platform.

        Args:
            site_id: Slug used for the site URL (a DNS label, e.g. ``my-app``).
            files: List of ``{"path": "index.html", "content": "<...>"}`` objects.
                Each file may include ``"encoding": "base64"`` for binary assets;
                the default encoding is utf-8 text.

        Returns:
            Deployment record with the live ``url``, the uploaded ``files``, the
            ``backend`` used, and a ``timestamp``.
        """
        site_id = _validate_site_id(site_id)
        prepared = self._prepare_files(files)
        if self.backend == "local":
            written = self._deploy_local(site_id, prepared)
        elif self.backend == "s3":
            written = self._deploy_s3(site_id, prepared)
        else:
            raise QuickDeployError(f"unknown backend {self.backend!r}: use 'local' or 's3'.")
        return {
            "site_id": site_id,
            "url": self._site_url(site_id),
            "backend": self.backend,
            "file_count": len(written),
            "files": [w["path"] for w in written],
            "bytes": sum(w["bytes"] for w in written),
            "has_index": any(w["path"] == DEFAULT_INDEX for w in written),
            "timestamp": datetime.now(UTC).isoformat(),
        }

    def list_sites(self) -> dict[str, Any]:
        """List sites currently deployed to the Quick platform."""
        if self.backend == "local":
            root = self.local_root
            sites = []
            if root.is_dir():
                for child in sorted(p for p in root.iterdir() if p.is_dir()):
                    files = [f for f in child.rglob("*") if f.is_file()]
                    sites.append(
                        {
                            "site_id": child.name,
                            "url": self._site_url(child.name),
                            "file_count": len(files),
                        }
                    )
            return {"backend": self.backend, "count": len(sites), "sites": sites}
        # S3 listing requires a signed ListObjectsV2 call; surface a clear hint
        # rather than returning a misleading empty list.
        raise QuickDeployError(
            "list_sites is only implemented for the 'local' backend; for s3/R2 "
            "inspect the bucket via your cloud console or the aws/rclone CLI."
        )

    def get_site(self, site_id: str) -> dict[str, Any]:
        """Return metadata and the file listing for one deployed site."""
        site_id = _validate_site_id(site_id)
        if self.backend == "local":
            site_dir = self.local_root / site_id
            if not site_dir.is_dir():
                raise QuickDeployError(f"site {site_id!r} not found.")
            files = []
            for f in sorted(p for p in site_dir.rglob("*") if p.is_file()):
                rel = f.relative_to(site_dir).as_posix()
                files.append(
                    {
                        "path": rel,
                        "content_type": _content_type(rel),
                        "bytes": f.stat().st_size,
                    }
                )
            return {
                "site_id": site_id,
                "url": self._site_url(site_id),
                "backend": self.backend,
                "file_count": len(files),
                "files": files,
            }
        raise QuickDeployError("get_site is only implemented for the 'local' backend.")

    def delete_site(self, site_id: str) -> dict[str, Any]:
        """Delete a deployed site and all of its files."""
        site_id = _validate_site_id(site_id)
        if self.backend == "local":
            site_dir = self.local_root / site_id
            if not site_dir.is_dir():
                raise QuickDeployError(f"site {site_id!r} not found.")
            removed = sum(1 for p in site_dir.rglob("*") if p.is_file())
            import shutil

            shutil.rmtree(site_dir)
            return {"site_id": site_id, "backend": self.backend, "deleted_files": removed}
        raise QuickDeployError("delete_site is only implemented for the 'local' backend.")

    # -- backends -------------------------------------------------------------

    def _deploy_local(self, site_id: str, files: list[dict[str, Any]]) -> list[dict[str, Any]]:
        site_root = (self.local_root / site_id).resolve()
        base = self.local_root.resolve()
        site_root.mkdir(parents=True, exist_ok=True)
        written = []
        for f in files:
            target = (site_root / f["path"]).resolve()
            if base not in target.parents and target != base:
                raise QuickDeployError(f"refusing to write outside site root: {f['path']!r}")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(f["data"])
            written.append({"path": f["path"], "bytes": len(f["data"])})
        return written

    def _deploy_s3(self, site_id: str, files: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not self.s3_bucket:
            raise QuickDeployError("QUICK_S3_BUCKET is not set; required for the s3 backend.")
        written = []
        for f in files:
            key = f"{site_id}/{f['path']}"
            url = self._s3_object_url(key)
            try:
                resp = self.client.put(
                    url,
                    content=f["data"],
                    headers={"Content-Type": f["content_type"]},
                )
                resp.raise_for_status()
            except httpx.HTTPStatusError as exc:
                raise QuickDeployError(
                    f"s3 upload failed for {key!r}: {exc.response.status_code} "
                    f"{exc.response.text[:200]}"
                ) from exc
            except httpx.RequestError as exc:
                raise QuickDeployError(f"s3 upload request failed for {key!r}: {exc}") from exc
            written.append({"path": f["path"], "bytes": len(f["data"])})
        return written

    # -- helpers (excluded from tool registration) ----------------------------

    @property
    def client(self) -> httpx.Client:
        if self._http is None:
            self._http = httpx.Client(timeout=self.timeout)
        return self._http

    def _prepare_files(self, files: list[dict[str, str]]) -> list[dict[str, Any]]:
        if not isinstance(files, list) or not files:
            raise QuickDeployError("files must be a non-empty list of {path, content} objects.")
        if len(files) > MAX_FILES:
            raise QuickDeployError(f"too many files: {len(files)} > {MAX_FILES}.")
        prepared: list[dict[str, Any]] = []
        seen: set[str] = set()
        total = 0
        for raw in files:
            if not isinstance(raw, dict):
                raise QuickDeployError("each file must be an object with 'path' and 'content'.")
            rel = _safe_relpath(str(raw.get("path", "")))
            if "content" not in raw or raw.get("content") is None:
                raise QuickDeployError(f"file {rel!r} is missing 'content'.")
            data = _decode_content(str(raw["content"]), str(raw.get("encoding", "")).lower())
            if len(data) > MAX_FILE_BYTES:
                raise QuickDeployError(
                    f"file {rel!r} exceeds per-file limit of {MAX_FILE_BYTES} bytes."
                )
            if rel in seen:
                raise QuickDeployError(f"duplicate file path {rel!r}.")
            seen.add(rel)
            total += len(data)
            if total > MAX_TOTAL_BYTES:
                raise QuickDeployError(f"artifact exceeds total limit of {MAX_TOTAL_BYTES} bytes.")
            prepared.append({"path": rel, "data": data, "content_type": _content_type(rel)})
        return prepared

    def _site_url(self, site_id: str) -> str:
        if self.public_base_url:
            return f"{self.public_base_url}/{site_id}/"
        return f"https://{site_id}.{self.base_domain}"

    def _s3_object_url(self, key: str) -> str:
        # Path-style addressing works for both R2 and AWS S3 and keeps the proxy
        # host-matching simple.
        if self.s3_endpoint:
            return f"{self.s3_endpoint}/{self.s3_bucket}/{key}"
        return f"https://s3.{self.s3_region}.amazonaws.com/{self.s3_bucket}/{key}"

    def close(self) -> None:
        if self._http is not None:
            self._http.close()
            self._http = None

    def __enter__(self) -> QuickClient:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


def _client() -> QuickClient:
    return QuickClient()
