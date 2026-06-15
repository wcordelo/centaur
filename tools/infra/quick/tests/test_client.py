import base64

import pytest
from quick.client import (
    QuickClient,
    QuickDeployError,
    _content_type,
    _safe_relpath,
    _validate_site_id,
    is_valid_site_id,
)


def _client(tmp_path):
    return QuickClient(backend="local", base_domain="quick.internal", local_root=str(tmp_path))


def test_validate_site_id_accepts_dns_labels():
    assert _validate_site_id("My-App") == "my-app"
    assert _validate_site_id("abc123") == "abc123"
    assert is_valid_site_id("a")
    assert is_valid_site_id("0")


@pytest.mark.parametrize("bad", ["", "-leading", "trailing-", "has_underscore", "a/b", "x" * 64])
def test_validate_site_id_rejects_invalid(bad):
    with pytest.raises(QuickDeployError):
        _validate_site_id(bad)
    assert not is_valid_site_id(bad)


def test_content_type_web_defaults():
    assert _content_type("index.html").startswith("text/html")
    assert _content_type("app.js").startswith("application/javascript")
    assert _content_type("style.css").startswith("text/css")
    assert _content_type("logo.svg") == "image/svg+xml"
    assert _content_type("data.bin") == "application/octet-stream"


@pytest.mark.parametrize("bad", ["../escape", "a/../../b", "..", "/.."])
def test_safe_relpath_blocks_traversal(bad):
    with pytest.raises(QuickDeployError):
        _safe_relpath(bad)


def test_safe_relpath_normalizes():
    assert _safe_relpath("/index.html") == "index.html"
    assert _safe_relpath("a//b/./c.js") == "a/b/c.js"


def test_deploy_local_writes_files_and_returns_url(tmp_path):
    client = _client(tmp_path)
    result = client.deploy_artifact(
        "demo-site",
        [
            {"path": "index.html", "content": "<h1>hi</h1>"},
            {"path": "assets/app.js", "content": "console.log(1)"},
        ],
    )
    assert result["url"] == "https://demo-site.quick.internal"
    assert result["file_count"] == 2
    assert result["has_index"] is True
    assert (tmp_path / "demo-site" / "index.html").read_text() == "<h1>hi</h1>"
    assert (tmp_path / "demo-site" / "assets" / "app.js").exists()


def test_deploy_local_base64(tmp_path):
    client = _client(tmp_path)
    payload = base64.b64encode(b"\x89PNG\r\n").decode()
    client.deploy_artifact("img", [{"path": "a.png", "content": payload, "encoding": "base64"}])
    assert (tmp_path / "img" / "a.png").read_bytes() == b"\x89PNG\r\n"


def test_deploy_requires_files(tmp_path):
    with pytest.raises(QuickDeployError):
        _client(tmp_path).deploy_artifact("site", [])


def test_deploy_rejects_duplicate_paths(tmp_path):
    with pytest.raises(QuickDeployError):
        _client(tmp_path).deploy_artifact(
            "site",
            [{"path": "a.html", "content": "1"}, {"path": "a.html", "content": "2"}],
        )


def test_lifecycle_list_get_delete(tmp_path):
    client = _client(tmp_path)
    client.deploy_artifact("one", [{"path": "index.html", "content": "1"}])
    client.deploy_artifact("two", [{"path": "index.html", "content": "2"}])

    listing = client.list_sites()
    assert listing["count"] == 2
    assert {s["site_id"] for s in listing["sites"]} == {"one", "two"}

    detail = client.get_site("one")
    assert detail["file_count"] == 1
    assert detail["files"][0]["content_type"].startswith("text/html")

    deleted = client.delete_site("one")
    assert deleted["deleted_files"] == 1
    assert client.list_sites()["count"] == 1
    with pytest.raises(QuickDeployError):
        client.get_site("one")


def test_redeploy_overwrites(tmp_path):
    client = _client(tmp_path)
    client.deploy_artifact("site", [{"path": "index.html", "content": "v1"}])
    client.deploy_artifact("site", [{"path": "index.html", "content": "v2"}])
    assert (tmp_path / "site" / "index.html").read_text() == "v2"


def test_unknown_backend_raises(tmp_path):
    client = QuickClient(backend="ftp", local_root=str(tmp_path))
    with pytest.raises(QuickDeployError):
        client.deploy_artifact("site", [{"path": "index.html", "content": "x"}])
