"""S3 backend tests via httpx.MockTransport — verifies ordering guarantees."""

import json

import httpx
import pytest
from quick.client import MANIFEST_PATH, QuickClient, QuickDeployError


class FakeBucket:
    """In-memory S3 stand-in recording the order of operations."""

    def __init__(self):
        self.objects: dict[str, bytes] = {}
        self.ops: list[tuple[str, str]] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        key = request.url.path.split("/bucket/", 1)[1]
        self.ops.append((request.method, key))
        if request.method == "PUT":
            self.objects[key] = request.content
            return httpx.Response(200)
        if request.method == "GET":
            if key in self.objects:
                return httpx.Response(200, content=self.objects[key])
            return httpx.Response(404)
        if request.method == "DELETE":
            self.objects.pop(key, None)
            return httpx.Response(204)
        return httpx.Response(405)


@pytest.fixture
def bucket():
    return FakeBucket()


def _s3_client(bucket, owner="alice"):
    client = QuickClient(
        backend="s3",
        base_domain="quick.internal",
        s3_bucket="bucket",
        s3_endpoint="https://fake-s3.test",
        owner=owner,
    )
    client._http = httpx.Client(transport=httpx.MockTransport(bucket.handler))
    return client


def test_s3_manifest_written_last(bucket):
    _s3_client(bucket).deploy_artifact(
        "demo",
        [
            {"path": "index.html", "content": "<h1>hi</h1>"},
            {"path": "app.js", "content": "1"},
        ],
    )
    puts = [k for m, k in bucket.ops if m == "PUT"]
    assert puts[-1] == f"demo/{MANIFEST_PATH}"
    manifest = json.loads(bucket.objects[f"demo/{MANIFEST_PATH}"])
    assert manifest["owner"] == "alice"


def test_s3_stale_cleanup_after_manifest(bucket):
    client = _s3_client(bucket)
    client.deploy_artifact("demo", [{"path": "old.js", "content": "1"}])
    result = client.deploy_artifact("demo", [{"path": "new.js", "content": "2"}])
    assert result["removed_stale"] == ["old.js"]
    assert "demo/old.js" not in bucket.objects
    # The DELETE of the stale file must come after the new manifest PUT.
    manifest_put = bucket.ops.index(("PUT", f"demo/{MANIFEST_PATH}"))
    stale_delete = bucket.ops.index(("DELETE", "demo/old.js"))
    assert stale_delete > manifest_put


def test_s3_ownership_enforced(bucket):
    _s3_client(bucket, owner="alice").deploy_artifact(
        "demo", [{"path": "index.html", "content": "x"}]
    )
    with pytest.raises(QuickDeployError, match="owned by 'alice'"):
        _s3_client(bucket, owner="bob").deploy_artifact(
            "demo", [{"path": "index.html", "content": "y"}]
        )


def test_s3_get_and_delete_via_manifest(bucket):
    client = _s3_client(bucket)
    client.deploy_artifact("demo", [{"path": "index.html", "content": "x"}])
    site = client.get_site("demo")
    assert site["file_count"] == 1
    deleted = client.delete_site("demo")
    assert deleted["deleted_files"] == 1
    assert not bucket.objects  # files and manifest both gone
    with pytest.raises(QuickDeployError, match="not found"):
        client.get_site("demo")
