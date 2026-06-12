"""Tests for site ownership, the deploy manifest, and the static server."""

import json
import threading

import httpx
import pytest
from quick.client import MANIFEST_PATH, QuickClient, QuickDeployError
from quick.server import make_server

INDEX = [{"path": "index.html", "content": "<h1>v1</h1>"}]


def _client(tmp_path, owner="alice"):
    return QuickClient(
        backend="local", base_domain="quick.internal", local_root=str(tmp_path), owner=owner
    )


# -- ownership ----------------------------------------------------------------


def test_first_deploy_records_owner(tmp_path):
    result = _client(tmp_path).deploy_artifact("demo", INDEX)
    assert result["owner"] == "alice"
    manifest = json.loads((tmp_path / "demo" / MANIFEST_PATH).read_text())
    assert manifest["owner"] == "alice"
    assert manifest["deploy_count"] == 1


def test_redeploy_by_other_owner_denied(tmp_path):
    _client(tmp_path, owner="alice").deploy_artifact("demo", INDEX)
    with pytest.raises(QuickDeployError, match="owned by 'alice'"):
        _client(tmp_path, owner="bob").deploy_artifact("demo", INDEX)


def test_delete_by_other_owner_denied(tmp_path):
    _client(tmp_path, owner="alice").deploy_artifact("demo", INDEX)
    with pytest.raises(QuickDeployError, match="delete as 'bob' denied"):
        _client(tmp_path, owner="bob").delete_site("demo")


def test_owner_can_redeploy_and_delete(tmp_path):
    client = _client(tmp_path)
    client.deploy_artifact("demo", INDEX)
    second = client.deploy_artifact("demo", [{"path": "index.html", "content": "<h1>v2</h1>"}])
    assert second["owner"] == "alice"
    manifest = json.loads((tmp_path / "demo" / MANIFEST_PATH).read_text())
    assert manifest["deploy_count"] == 2
    client.delete_site("demo")
    assert not (tmp_path / "demo").exists()


# -- atomic redeploy / stale cleanup -------------------------------------------


def test_redeploy_removes_stale_files(tmp_path):
    client = _client(tmp_path)
    client.deploy_artifact(
        "demo", INDEX + [{"path": "old/bundle.v1.js", "content": "console.log(1)"}]
    )
    client.deploy_artifact("demo", INDEX)
    assert not (tmp_path / "demo" / "old" / "bundle.v1.js").exists()
    assert (tmp_path / "demo" / "index.html").read_text() == "<h1>v1</h1>"


def test_no_staging_leftovers(tmp_path):
    client = _client(tmp_path)
    client.deploy_artifact("demo", INDEX)
    staging = tmp_path / ".staging"
    assert not staging.exists() or not any(staging.iterdir())


def test_reserved_prefix_rejected(tmp_path):
    with pytest.raises(QuickDeployError, match="reserved"):
        _client(tmp_path).deploy_artifact(
            "demo", [{"path": "_quick/manifest.json", "content": "{}"}]
        )


def test_listings_hide_manifest(tmp_path):
    client = _client(tmp_path)
    client.deploy_artifact("demo", INDEX)
    site = client.get_site("demo")
    assert site["file_count"] == 1
    assert all(f["path"] != MANIFEST_PATH for f in site["files"])
    listing = client.list_sites()
    assert listing["sites"][0]["file_count"] == 1
    assert listing["sites"][0]["owner"] == "alice"


# -- static server --------------------------------------------------------------


@pytest.fixture
def served_site(tmp_path):
    client = _client(tmp_path)
    client.deploy_artifact(
        "demo",
        INDEX + [{"path": "assets/app.js", "content": "console.log('hi')"}],
    )
    server = make_server(host="127.0.0.1", port=0, root=str(tmp_path), base_domain="quick.internal")
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


def test_server_serves_index_via_host_header(served_site):
    resp = httpx.get(served_site, headers={"Host": "demo.quick.internal"})
    assert resp.status_code == 200
    assert resp.text == "<h1>v1</h1>"
    assert resp.headers["content-type"].startswith("text/html")


def test_server_serves_assets_and_path_fallback(served_site):
    resp = httpx.get(f"{served_site}/assets/app.js", headers={"Host": "demo.quick.internal"})
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/javascript")
    resp = httpx.get(f"{served_site}/sites/demo/index.html")
    assert resp.status_code == 200


def test_server_hides_manifest_and_blocks_traversal(served_site):
    resp = httpx.get(f"{served_site}/{MANIFEST_PATH}", headers={"Host": "demo.quick.internal"})
    assert resp.status_code == 404
    resp = httpx.get(
        f"{served_site}/sites/demo/..%2F..%2Fetc%2Fpasswd",
    )
    assert resp.status_code in (403, 404)


def test_server_unknown_site_404(served_site):
    resp = httpx.get(served_site, headers={"Host": "nope.quick.internal"})
    assert resp.status_code == 404
