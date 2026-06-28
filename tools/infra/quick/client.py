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

import base64
import json
import mimetypes
import re
import shutil
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

from centaur_sdk import secret

from .site_paths import (
    DEFAULT_BASE_DOMAIN,
    DEFAULT_INDEX,
    DEFAULT_LOCAL_ROOT,
    MANIFEST_DIR,
    MANIFEST_PATH,
    content_type as _content_type,
    is_valid_site_id,
)

# A site_id becomes a DNS label (``<site_id>.quick.internal``), so it must be a
# valid, lowercase DNS label: 1-63 chars, alphanumeric, internal hyphens only.
_SITE_ID_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")
DEFAULT_OWNER = "anonymous"

MAX_FILES = 500
MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_TOTAL_BYTES = 100 * 1024 * 1024


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
    if parts[0] == MANIFEST_DIR:
        raise QuickDeployError(
            f"file path {raw_path!r} is reserved: '{MANIFEST_DIR}/' holds Quick metadata."
        )
    return "/".join(parts)


def _decode_content(content: str, encoding: str) -> bytes:
    if encoding == "base64":
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
        owner: str | None = None,
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
        # Requester identity (Centaur injects QUICK_REQUESTER per tool call).
        # Resolved lazily so a cached QuickClient still sees the active requester.
        self._owner_override = owner
        self.enforce_ownership = (
            _cfg("QUICK_OWNERSHIP_ENFORCE", "true").strip().lower() != "false"
        )
        self.timeout = timeout
        self._http: httpx.Client | None = None

    @property
    def owner(self) -> str:
        """Active requester for ownership checks and manifest stamping."""
        if self._owner_override is not None:
            return self._owner_override.strip() or DEFAULT_OWNER
        return _cfg("QUICK_REQUESTER", DEFAULT_OWNER).strip() or DEFAULT_OWNER

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
        previous = self._read_manifest(site_id)
        self._check_owner(site_id, previous, action="redeploy")
        manifest = self._build_manifest(site_id, prepared, previous)
        if self.backend == "local":
            written = self._deploy_local(site_id, prepared, manifest)
            removed_stale: list[str] = []  # swap replaces the whole tree
        elif self.backend == "s3":
            written = self._deploy_s3(site_id, prepared, manifest)
            removed_stale = self._cleanup_stale_s3(site_id, previous, prepared)
        else:
            raise QuickDeployError(f"unknown backend {self.backend!r}: use 'local' or 's3'.")
        return {
            "site_id": site_id,
            "url": self._site_url(site_id),
            "backend": self.backend,
            "owner": manifest["owner"],
            "file_count": len(written),
            "files": [w["path"] for w in written],
            "removed_stale": removed_stale,
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
                for child in sorted(
                    p for p in root.iterdir() if p.is_dir() and not p.name.startswith(".")
                ):
                    files = [
                        f
                        for f in child.rglob("*")
                        if f.is_file() and MANIFEST_DIR not in f.relative_to(child).parts
                    ]
                    manifest = self._read_manifest(child.name) or {}
                    sites.append(
                        {
                            "site_id": child.name,
                            "url": self._site_url(child.name),
                            "owner": manifest.get("owner", DEFAULT_OWNER),
                            "updated_at": manifest.get("updated_at"),
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
            manifest = self._read_manifest(site_id) or {}
            files = []
            for f in sorted(p for p in site_dir.rglob("*") if p.is_file()):
                rel = f.relative_to(site_dir).as_posix()
                if rel.split("/", 1)[0] == MANIFEST_DIR:
                    continue
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
                "owner": manifest.get("owner", DEFAULT_OWNER),
                "updated_at": manifest.get("updated_at"),
                "file_count": len(files),
                "files": files,
            }
        manifest = self._read_manifest(site_id)
        if manifest is None:
            raise QuickDeployError(f"site {site_id!r} not found (no manifest in bucket).")
        return {
            "site_id": site_id,
            "url": self._site_url(site_id),
            "backend": self.backend,
            "owner": manifest.get("owner", DEFAULT_OWNER),
            "updated_at": manifest.get("updated_at"),
            "file_count": len(manifest.get("files", [])),
            "files": manifest.get("files", []),
        }

    def delete_site(self, site_id: str) -> dict[str, Any]:
        """Delete a deployed site and all of its files."""
        site_id = _validate_site_id(site_id)
        manifest = self._read_manifest(site_id)
        self._check_owner(site_id, manifest, action="delete")
        if self.backend == "local":
            site_dir = self.local_root / site_id
            if not site_dir.is_dir():
                raise QuickDeployError(f"site {site_id!r} not found.")
            removed = sum(
                1
                for p in site_dir.rglob("*")
                if p.is_file() and MANIFEST_DIR not in p.relative_to(site_dir).parts
            )
            shutil.rmtree(site_dir)
            return {"site_id": site_id, "backend": self.backend, "deleted_files": removed}
        if manifest is None:
            raise QuickDeployError(f"site {site_id!r} not found (no manifest in bucket).")
        deleted = 0
        for f in manifest.get("files", []):
            if f.get("path"):
                self._delete_s3_object(f"{site_id}/{f['path']}")
                deleted += 1
        # Manifest goes last so an interrupted delete is retryable.
        self._delete_s3_object(f"{site_id}/{MANIFEST_PATH}")
        return {"site_id": site_id, "backend": self.backend, "deleted_files": deleted}

    # -- backends -------------------------------------------------------------

    def _deploy_local(
        self, site_id: str, files: list[dict[str, Any]], manifest: dict[str, Any]
    ) -> list[dict[str, Any]]:
        """Atomically deploy by building a staging tree, then swapping it live.

        Readers (the static server) only ever see the old complete tree or the
        new complete tree — never a half-written mix. Stale files from the
        previous deploy disappear with the swap by construction.
        """
        base = self.local_root.resolve()
        staging_parent = base / ".staging"
        staging = staging_parent / f"{site_id}.{uuid.uuid4().hex[:12]}"
        trash = staging_parent / f"{site_id}.trash.{uuid.uuid4().hex[:12]}"
        staging.mkdir(parents=True, exist_ok=False)
        written = []
        live = base / site_id
        trash_has_backup = False
        swap_restore_failed = False
        try:
            for f in files:
                target = (staging / f["path"]).resolve()
                if staging.resolve() not in target.parents:
                    raise QuickDeployError(
                        f"refusing to write outside site root: {f['path']!r}"
                    )
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(f["data"])
                written.append({"path": f["path"], "bytes": len(f["data"])})
            manifest_file = staging / MANIFEST_PATH
            manifest_file.parent.mkdir(parents=True, exist_ok=True)
            manifest_file.write_text(json.dumps(manifest, indent=2))
            # Swap: live -> trash, staging -> live. Each rename is atomic.
            if live.exists():
                live.rename(trash)
                trash_has_backup = True
            try:
                staging.rename(live)
            except OSError:
                if trash_has_backup and trash.exists():
                    try:
                        trash.rename(live)
                    except OSError:
                        swap_restore_failed = True
                raise
        finally:
            shutil.rmtree(staging, ignore_errors=True)
            # If restore failed, trash is the only copy of the previous live tree.
            if trash_has_backup and not swap_restore_failed:
                shutil.rmtree(trash, ignore_errors=True)
        return written

    def _deploy_s3(
        self, site_id: str, files: list[dict[str, Any]], manifest: dict[str, Any]
    ) -> list[dict[str, Any]]:
        if not self.s3_bucket:
            raise QuickDeployError("QUICK_S3_BUCKET is not set; required for the s3 backend.")
        written = []
        for f in files:
            self._put_s3_object(f"{site_id}/{f['path']}", f["data"], f["content_type"])
            written.append({"path": f["path"], "bytes": len(f["data"])})
        # The manifest is written last: if any file upload failed above we never
        # get here, so an incomplete deploy is never recorded as the current one.
        self._put_s3_object(
            f"{site_id}/{MANIFEST_PATH}",
            json.dumps(manifest, indent=2).encode("utf-8"),
            "application/json; charset=utf-8",
        )
        return written

    # -- helpers (excluded from tool registration) ----------------------------

    def _build_manifest(
        self,
        site_id: str,
        prepared: list[dict[str, Any]],
        previous: dict[str, Any] | None,
    ) -> dict[str, Any]:
        now = datetime.now(UTC).isoformat()
        return {
            "site_id": site_id,
            "owner": (previous or {}).get("owner", self.owner),
            "created_at": (previous or {}).get("created_at", now),
            "updated_at": now,
            "deploy_count": int((previous or {}).get("deploy_count", 0)) + 1,
            "backend": self.backend,
            "files": [
                {"path": f["path"], "bytes": len(f["data"]), "content_type": f["content_type"]}
                for f in prepared
            ],
        }

    def _check_owner(
        self, site_id: str, manifest: dict[str, Any] | None, *, action: str
    ) -> None:
        """Reject mutating an existing site owned by someone else."""
        if manifest is None or not self.enforce_ownership:
            return
        owner = manifest.get("owner") or DEFAULT_OWNER
        if owner != self.owner:
            raise QuickDeployError(
                f"site {site_id!r} is owned by {owner!r}; {action} as {self.owner!r} denied. "
                "Pick a different site_id, or set QUICK_OWNERSHIP_ENFORCE=false to override."
            )

    def _read_manifest(self, site_id: str) -> dict[str, Any] | None:
        """Return the current manifest for a site, or None if never deployed."""
        if self.backend == "local":
            path = self.local_root / site_id / MANIFEST_PATH
            if not path.is_file():
                return None
            try:
                return json.loads(path.read_text())
            except (OSError, ValueError):
                return None
        data = self._get_s3_object(f"{site_id}/{MANIFEST_PATH}", missing_ok=True)
        if data is None:
            return None
        try:
            return json.loads(data)
        except ValueError:
            return None

    def _cleanup_stale_s3(
        self,
        site_id: str,
        previous: dict[str, Any] | None,
        prepared: list[dict[str, Any]],
    ) -> list[str]:
        """Delete files present in the previous deploy but absent from this one.

        Runs after the new manifest is written, so a cleanup failure leaves only
        harmless extra objects behind — never a broken current deploy.
        """
        if not previous:
            return []
        old_paths = {f.get("path") for f in previous.get("files", []) if f.get("path")}
        new_paths = {f["path"] for f in prepared}
        removed = []
        for stale in sorted(old_paths - new_paths):
            try:
                self._delete_s3_object(f"{site_id}/{stale}")
                removed.append(stale)
            except QuickDeployError:
                continue  # best-effort; stale objects are inert
        return removed

    def _put_s3_object(self, key: str, data: bytes, content_type: str) -> None:
        url = self._s3_object_url(key)
        try:
            resp = self.client.put(url, content=data, headers={"Content-Type": content_type})
            resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise QuickDeployError(
                f"s3 upload failed for {key!r}: {exc.response.status_code} "
                f"{exc.response.text[:200]}"
            ) from exc
        except httpx.RequestError as exc:
            raise QuickDeployError(f"s3 upload request failed for {key!r}: {exc}") from exc

    def _get_s3_object(self, key: str, *, missing_ok: bool = False) -> bytes | None:
        url = self._s3_object_url(key)
        try:
            resp = self.client.get(url)
            if resp.status_code == 404 and missing_ok:
                return None
            resp.raise_for_status()
            return resp.content
        except httpx.HTTPStatusError as exc:
            raise QuickDeployError(
                f"s3 fetch failed for {key!r}: {exc.response.status_code}"
            ) from exc
        except httpx.RequestError as exc:
            raise QuickDeployError(f"s3 fetch request failed for {key!r}: {exc}") from exc

    def _delete_s3_object(self, key: str) -> None:
        url = self._s3_object_url(key)
        try:
            resp = self.client.delete(url)
            if resp.status_code not in (200, 204, 404):
                resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise QuickDeployError(
                f"s3 delete failed for {key!r}: {exc.response.status_code}"
            ) from exc
        except httpx.RequestError as exc:
            raise QuickDeployError(f"s3 delete request failed for {key!r}: {exc}") from exc

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
