"""Tests for Scribe's HTTP surface (``backend/routes.py``).

Lives in the repo-level ``test/`` tree because ``setup.cfg`` sets
``testpaths = test transfer`` — a test under ``src/kiro_crew/apps/builtins/...``
is never collected by CI.

Handlers are driven directly with ``aiohttp.test_utils.make_mocked_request``
(the papyrus/issue_radar approach): no server bound, no subprocess spawned, and
the data dir is monkeypatched to a tmp path so no test touches the real app
home.

Coverage targets, in the order a request is authorized:

  1. ``_require_enabled`` — the app is opt-in, so every route must refuse with
     403 while disabled.
  2. ``_safe_doc`` — an invalid or traversal-bearing name is a 400 before any
     filesystem touch.
  3. The mtime guard — a save whose ``baseMtime`` predates the file's on-disk
     mtime is a 409 with ``code: "stale"``, the contract the frontend's
     conflict banner depends on.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any
from unittest import mock

import pytest
from aiohttp import web
from aiohttp.test_utils import make_mocked_request

from kiro_crew.apps.builtins.scribe.backend import routes


def _request(method: str, path: str, body: dict[str, Any] | None = None) -> web.Request:
    request = make_mocked_request(method, path)
    request.json = mock.AsyncMock(return_value=body if body is not None else {})  # type: ignore[method-assign]
    return request


def _json_of(response: web.StreamResponse) -> dict[str, Any]:
    assert isinstance(response, web.Response)
    assert isinstance(response.body, (bytes, bytearray))
    return json.loads(response.body)


@pytest.fixture()
def enabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(routes, "is_app_enabled", lambda _name: True)


@pytest.fixture()
def data_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    root = tmp_path / "scribe-data"
    root.mkdir()
    monkeypatch.setattr(routes, "app_data_dir", lambda _name: root)
    return root


@pytest.fixture()
def doc(data_root: Path) -> Path:
    docs = data_root / "docs"
    docs.mkdir()
    path = docs / "design.md"
    path.write_text("# Design\n", encoding="utf-8")
    return path


@pytest.mark.asyncio
class TestRequireEnabled:
    async def test_denies_every_route_while_disabled(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(routes, "is_app_enabled", lambda _name: False)
        guarded = routes._require_enabled(routes._handle_list_docs)
        response = await guarded(_request("GET", "/api/apps/scribe/docs"))
        assert response.status == 403
        assert _json_of(response)["code"] == "app_disabled"

    async def test_allows_the_route_when_enabled(self, enabled: None, data_root: Path) -> None:
        guarded = routes._require_enabled(routes._handle_list_docs)
        response = await guarded(_request("GET", "/api/apps/scribe/docs"))
        assert response.status == 200


class TestRouteRegistration:
    def test_every_registered_route_is_guarded(self) -> None:
        """A route added without the gate would stay reachable while the app is
        disabled — the regression this pins."""
        app = web.Application()
        routes.register_routes(app)
        registered = [
            r for r in app.router.routes()
            if r.resource is not None and r.method != "HEAD"  # auto-added GET twins
        ]
        assert registered, "no routes registered"
        for route in registered:
            assert getattr(route.handler, "__wrapped__", None) is not None, (
                f"{route.method} {route.resource} is not wrapped by _require_enabled"
            )


class TestSafeDoc:
    """The containment gate, exercised directly (synchronous)."""

    def test_rejects_traversal_and_separators(self, data_root: Path) -> None:
        for bad in ("../evil", "a/b", "a\\b", ".hidden", "", " ", "x" * 70):
            with pytest.raises(ValueError):
                routes._safe_doc(bad)

    def test_rejects_symlink(self, data_root: Path, tmp_path: Path) -> None:
        docs = routes.docs_dir()
        docs.mkdir(parents=True, exist_ok=True)
        outside = tmp_path / "outside.md"
        outside.write_text("secret", encoding="utf-8")
        (docs / "link.md").symlink_to(outside)
        with pytest.raises(ValueError):
            routes._safe_doc("link")

    def test_accepts_a_plain_name(self, data_root: Path) -> None:
        path = routes._safe_doc("my design 2.md-notes")
        assert path.parent == routes.docs_dir().resolve()
        assert path.suffix == ".md"


@pytest.mark.asyncio
class TestDocCrud:
    async def test_create_read_roundtrip(self, enabled: None, data_root: Path) -> None:
        created = _json_of(await routes._handle_create_doc(
            _request("POST", "/api/apps/scribe/docs", {"name": "notes"})
        ))
        assert created["name"] == "notes"
        assert Path(created["path"]).is_file()

        read = _json_of(await routes._handle_read_doc(
            make_mocked_request("GET", "/api/apps/scribe/doc?name=notes")
        ))
        assert read["content"].startswith("# notes")
        assert read["mtime"] > 0

    async def test_create_duplicate_is_409(self, enabled: None, doc: Path) -> None:
        response = await routes._handle_create_doc(
            _request("POST", "/api/apps/scribe/docs", {"name": "design"})
        )
        assert response.status == 409

    async def test_read_missing_is_404_and_bad_name_400(self, enabled: None, data_root: Path) -> None:
        assert (await routes._handle_read_doc(
            make_mocked_request("GET", "/api/apps/scribe/doc?name=absent")
        )).status == 404
        assert (await routes._handle_read_doc(
            make_mocked_request("GET", "/api/apps/scribe/doc?name=../evil")
        )).status == 400

    async def test_save_roundtrip(self, enabled: None, doc: Path) -> None:
        base = doc.stat().st_mtime * 1000.0
        response = await routes._handle_save_doc(_request(
            "PUT", "/api/apps/scribe/doc",
            {"name": "design", "content": "# Design\n\nBody.\n", "baseMtime": base},
        ))
        assert response.status == 200
        assert doc.read_text(encoding="utf-8").endswith("Body.\n")

    async def test_stale_save_is_409(self, enabled: None, doc: Path) -> None:
        """The mtime guard: the frontend's conflict banner depends on this
        exact status + code contract."""
        stale_base = doc.stat().st_mtime * 1000.0
        # The co-author writes the file after the page's read.
        time.sleep(0.01)
        doc.write_text("# Design\n\nAgent edit.\n", encoding="utf-8")
        os.utime(doc, (time.time(), time.time()))
        response = await routes._handle_save_doc(_request(
            "PUT", "/api/apps/scribe/doc",
            {"name": "design", "content": "user edit", "baseMtime": stale_base},
        ))
        assert response.status == 409
        assert _json_of(response)["code"] == "stale"
        # And the agent's content was not clobbered.
        assert "Agent edit." in doc.read_text(encoding="utf-8")

    async def test_stale_save_within_one_fs_tick_is_409(self, enabled: None, doc: Path) -> None:
        """Regression: filesystem mtime granularity can be coarse (10ms observed
        live), so a save and a racing stale save can land in the SAME timestamp
        tick. The save path stamps the mtime strictly past the base token, so
        the second writer's token is stale even with zero wall-clock movement."""
        base = doc.stat().st_mtime * 1000.0
        first = await routes._handle_save_doc(_request(
            "PUT", "/api/apps/scribe/doc",
            {"name": "design", "content": "first writer", "baseMtime": base},
        ))
        assert first.status == 200
        second = await routes._handle_save_doc(_request(
            "PUT", "/api/apps/scribe/doc",
            {"name": "design", "content": "second writer, same base", "baseMtime": base},
        ))
        assert second.status == 409
        assert "first writer" in doc.read_text(encoding="utf-8")

    async def test_save_missing_fields_is_400(self, enabled: None, doc: Path) -> None:
        response = await routes._handle_save_doc(_request(
            "PUT", "/api/apps/scribe/doc", {"name": "design", "content": "x"}
        ))
        assert response.status == 400

    async def test_oversize_save_is_413(self, enabled: None, doc: Path) -> None:
        response = await routes._handle_save_doc(_request(
            "PUT", "/api/apps/scribe/doc",
            {"name": "design", "content": "x" * (routes._MAX_DOC_BYTES + 1),
             "baseMtime": doc.stat().st_mtime * 1000.0},
        ))
        assert response.status == 413


@pytest.mark.asyncio
class TestSlotMapping:
    """The doc->slot mapping behind co-author session reattach."""

    async def test_get_unmapped_doc_returns_null(self, enabled: None, data_root: Path) -> None:
        response = await routes._handle_get_slot(_request("GET", "/api/apps/scribe/slot?name=design"))
        assert response.status == 200
        assert _json_of(response)["slot"] is None

    async def test_put_then_get_roundtrip(self, enabled: None, data_root: Path) -> None:
        put = await routes._handle_put_slot(
            _request("PUT", "/api/apps/scribe/slot", {"name": "design", "slot": "dashboard_chat-7-123"})
        )
        assert put.status == 200
        got = await routes._handle_get_slot(_request("GET", "/api/apps/scribe/slot?name=design"))
        assert _json_of(got)["slot"] == "dashboard_chat-7-123"
        # Persisted server-side, not in any browser store.
        on_disk = json.loads(routes.slots_file(data_root).read_text(encoding="utf-8"))
        assert on_disk == {"design": "dashboard_chat-7-123"}

    async def test_put_overwrites_existing_mapping(self, enabled: None, data_root: Path) -> None:
        for slot in ("dashboard_chat-7-1", "dashboard_chat-7-2"):
            await routes._handle_put_slot(
                _request("PUT", "/api/apps/scribe/slot", {"name": "design", "slot": slot})
            )
        got = await routes._handle_get_slot(_request("GET", "/api/apps/scribe/slot?name=design"))
        assert _json_of(got)["slot"] == "dashboard_chat-7-2"

    async def test_rejects_invalid_doc_name(self, enabled: None, data_root: Path) -> None:
        response = await routes._handle_get_slot(_request("GET", "/api/apps/scribe/slot?name=../etc"))
        assert response.status == 400
        response = await routes._handle_put_slot(
            _request("PUT", "/api/apps/scribe/slot", {"name": "../etc", "slot": "dashboard_chat-7-1"})
        )
        assert response.status == 400

    async def test_rejects_invalid_slot_key(self, enabled: None, data_root: Path) -> None:
        response = await routes._handle_put_slot(
            _request("PUT", "/api/apps/scribe/slot", {"name": "design", "slot": "bad key\nwith newline"})
        )
        assert response.status == 400

    async def test_corrupt_mapping_file_reads_as_empty(self, enabled: None, data_root: Path) -> None:
        routes.slots_file(data_root).write_text("not json{", encoding="utf-8")
        response = await routes._handle_get_slot(_request("GET", "/api/apps/scribe/slot?name=design"))
        assert response.status == 200
        assert _json_of(response)["slot"] is None
