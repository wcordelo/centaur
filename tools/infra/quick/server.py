"""Quick static server — serves deployed sites for the local backend.

Maps requests to site folders under ``QUICK_LOCAL_ROOT`` two ways:

- Wildcard host routing: ``<site_id>.<QUICK_BASE_DOMAIN>`` -> ``<root>/<site_id>``
  (the production-style path; point a wildcard DNS record / ingress here).
- Path routing fallback: ``/sites/<site_id>/...`` for plain ``localhost`` use,
  so the end-to-end flow needs zero DNS setup during development.

Never serves the reserved ``_quick/`` metadata prefix, dotfiles, or the
``.staging`` area; resolves paths defensively so crafted URLs cannot escape a
site root. Directory requests fall back to ``index.html``.

Run: ``python -m quick.server`` (env: QUICK_LOCAL_ROOT, QUICK_BASE_DOMAIN,
QUICK_SERVER_HOST, QUICK_SERVER_PORT).

Authentication is intentionally not implemented here: in production the
platform sits behind an identity-aware proxy (Cloudflare Access / Google IAP)
exactly as in the architecture reference — the server stays auth-agnostic.
"""

from __future__ import annotations

import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

from .client import (
    DEFAULT_BASE_DOMAIN,
    DEFAULT_INDEX,
    DEFAULT_LOCAL_ROOT,
    MANIFEST_DIR,
    _content_type,
)


def _resolve_site_and_path(host: str, raw_path: str, base_domain: str) -> tuple[str, str] | None:
    """Extract (site_id, relative file path) from the request, or None."""
    path = unquote(urlsplit(raw_path).path)
    hostname = (host or "").split(":")[0].strip().lower()
    suffix = "." + base_domain
    if hostname.endswith(suffix):
        site_id = hostname[: -len(suffix)]
        if site_id and "." not in site_id:
            return site_id, path.lstrip("/")
    # Fallback: /sites/<site_id>/<path...>
    parts = path.lstrip("/").split("/", 2)
    if len(parts) >= 2 and parts[0] == "sites" and parts[1]:
        return parts[1], parts[2] if len(parts) == 3 else ""
    return None


class QuickRequestHandler(BaseHTTPRequestHandler):
    root: Path = Path(DEFAULT_LOCAL_ROOT)
    base_domain: str = DEFAULT_BASE_DOMAIN

    def do_GET(self) -> None:  # noqa: N802 (stdlib naming)
        self._serve(head=False)

    def do_HEAD(self) -> None:  # noqa: N802
        self._serve(head=True)

    def _serve(self, *, head: bool) -> None:
        path = unquote(urlsplit(self.path).path)
        if path in ("/healthz", "/health"):
            body = b"ok\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            if not head:
                self.wfile.write(body)
            return

        routed = _resolve_site_and_path(
            self.headers.get("Host", ""), self.path, self.base_domain
        )
        if routed is None:
            return self._error(404, "unknown site", head=head)
        site_id, rel = routed
        if site_id.startswith("."):
            return self._error(404, "unknown site", head=head)

        site_root = (self.root / site_id).resolve()
        base = self.root.resolve()
        if not site_root.is_dir() or site_root.parent != base:
            return self._error(404, "unknown site", head=head)

        rel = rel or DEFAULT_INDEX
        target = (site_root / rel).resolve()
        # Defense in depth: stay inside the site root, never expose metadata.
        if site_root != target and site_root not in target.parents:
            return self._error(403, "forbidden", head=head)
        rel_parts = target.relative_to(site_root).parts if target != site_root else ()
        if any(p == MANIFEST_DIR or p.startswith(".") for p in rel_parts):
            return self._error(404, "not found", head=head)

        if target.is_dir():
            target = target / DEFAULT_INDEX
        if not target.is_file():
            return self._error(404, "not found", head=head)

        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", _content_type(target.name))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if not head:
            self.wfile.write(data)

    def _error(self, code: int, message: str, *, head: bool = False) -> None:
        body = message.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def log_message(self, fmt: str, *args: object) -> None:
        host = self.headers.get("Host", "-")
        print(f"[quick-server] {host} {fmt % args}")


def make_server(
    host: str = "0.0.0.0",
    port: int = 8943,
    root: str | None = None,
    base_domain: str | None = None,
) -> ThreadingHTTPServer:
    handler = type(
        "BoundQuickRequestHandler",
        (QuickRequestHandler,),
        {
            "root": Path(root or os.environ.get("QUICK_LOCAL_ROOT", DEFAULT_LOCAL_ROOT)),
            "base_domain": (
                base_domain or os.environ.get("QUICK_BASE_DOMAIN", DEFAULT_BASE_DOMAIN)
            ).strip("."),
        },
    )
    return ThreadingHTTPServer((host, port), handler)


def main() -> None:
    host = os.environ.get("QUICK_SERVER_HOST", "0.0.0.0")
    port = int(os.environ.get("QUICK_SERVER_PORT", "8943"))
    server = make_server(host, port)
    handler = server.RequestHandlerClass
    print(f"[quick-server] serving {handler.root} on {host}:{port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
