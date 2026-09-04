"""Scribe — backend routes.

Registered on the gateway's own aiohttp application at startup (via the
manifest's ``backend.routes`` field), the same in-process shape as ``papyrus``:
no separate server process, no port, and the gateway's auth/CSP/audit apply.

Routes (browser-facing, same-origin authed; the app token must also declare
``/api/apps/scribe`` in ``permissions.api``):

  GET  /api/apps/scribe/docs               -> {"docs": [{"name", "mtime"}]}
  POST /api/apps/scribe/docs               {"name"} -> {"name", "path", "mtime"}
  GET  /api/apps/scribe/doc?name=<slug>    -> {"name", "path", "content", "mtime"}
  PUT  /api/apps/scribe/doc                {"name", "content", "baseMtime"} -> {"mtime"}
  GET  /api/apps/scribe/slot?name=<slug>   -> {"slot": <key> | null}
  PUT  /api/apps/scribe/slot               {"name", "slot"} -> {"ok": true}

Authorization follows papyrus's three rules, collapsed for a two-route app:

1. ``_require_enabled`` — routes are registered once at startup, so every
   handler refuses with 403 while the app is disabled (``defaultEnabled`` is
   false).
2. ``_safe_doc`` — the document name must be a single validated slug that
   resolves inside the app's own data dir. A name that fails is a 400, never a
   filesystem touch.
3. Every filesystem call (including the validation's ``resolve()``/``stat``)
   runs off the event loop behind one ``asyncio.to_thread`` hop per handler,
   with no ``await`` between check and use.

The PUT carries an mtime token: the read returns the file's mtime, the save
refuses with 409 when the file changed on disk since that read. The page's
reload-on-idle deliberately re-reads (adopting the agent's edit) instead of
flushing, so in normal co-author flow the 409 only fires when the user saves a
stale buffer — the conflict it exists to catch.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from functools import wraps
from pathlib import Path
from typing import Any, Awaitable, Callable

from aiohttp import web

from kiro_crew.apps.manager import app_data_dir, is_app_enabled
from kiro_crew.atomic_write import atomic_write

logger = logging.getLogger("kirocrew.app.scribe")

APP_NAME = "scribe"
API_BASE = "/api/apps/scribe"

#: A document name is one slug segment: no separators, no dotfiles, no traversal.
_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$")

#: Refuse writes past this size; a prototype editor has no business with more.
_MAX_DOC_BYTES = 2 * 1024 * 1024

#: Tolerance for mtime comparison, mirroring md_notebook's guard (ms).
_MTIME_TOLERANCE_MS = 1.0

#: Chat slot keys are dashboard-minted (e.g. ``dashboard_chat-90-17871…``):
#: one printable token, never user prose. Anything else is refused.
_SLOT_RE = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")

#: Serializes read-modify-write of the slot-mapping file. One gateway process
#: owns the file, so an asyncio lock is sufficient (no cross-process writers).
_slots_lock = asyncio.Lock()

_Handler = Callable[[web.Request], Awaitable[web.StreamResponse]]


def docs_dir(root: Path | None = None) -> Path:
    """The directory holding all Scribe documents (created on demand)."""
    base = root if root is not None else app_data_dir(APP_NAME)
    return base / "docs"


def _safe_doc(name: str, root: Path | None = None) -> Path:
    """Resolve a document name to a contained ``.md`` path, or raise ValueError.

    Containment is by construction (single validated slug appended to the docs
    dir) plus a ``resolve()`` re-check, mirroring papyrus's ``safe_child``
    discipline. Synchronous filesystem code — call from a worker thread.
    """
    cleaned = name.strip()
    if not _NAME_RE.match(cleaned) or ".." in cleaned:
        raise ValueError("invalid document name")
    base = docs_dir(root)
    base.mkdir(parents=True, exist_ok=True)
    candidate = (base / f"{cleaned}.md").resolve()
    if candidate.parent != base.resolve():
        raise ValueError("invalid document name")
    if candidate.is_symlink():
        raise ValueError("document is a symlink")
    return candidate


def _mtime_ms(path: Path) -> float:
    return path.stat().st_mtime * 1000.0


def _require_enabled(handler: _Handler) -> _Handler:
    """Deny every request while Scribe is disabled (deny-by-default)."""

    @wraps(handler)
    async def _wrapped(request: web.Request) -> web.StreamResponse:
        if not await asyncio.to_thread(is_app_enabled, APP_NAME):
            return web.json_response(
                {"error": "scribe is disabled", "code": "app_disabled"}, status=403
            )
        return await handler(request)

    return _wrapped


async def _json_body(request: web.Request) -> dict[str, Any] | None:
    try:
        body = await request.json()
    except Exception:
        return None
    return body if isinstance(body, dict) else None


async def _handle_list_docs(request: web.Request) -> web.StreamResponse:
    def _list() -> list[dict[str, Any]]:
        base = docs_dir()
        if not base.is_dir():
            return []
        out: list[dict[str, Any]] = []
        for p in sorted(base.glob("*.md")):
            if p.is_symlink() or not p.is_file():
                continue
            out.append({"name": p.stem, "mtime": _mtime_ms(p)})
        return out

    return web.json_response({"docs": await asyncio.to_thread(_list)})


async def _handle_create_doc(request: web.Request) -> web.StreamResponse:
    body = await _json_body(request)
    name = str(body.get("name", "")) if body else ""

    def _create() -> dict[str, Any]:
        path = _safe_doc(name)
        if path.exists():
            raise FileExistsError(name)
        atomic_write(path, f"# {name.strip()}\n\n")
        return {"name": path.stem, "path": str(path), "mtime": _mtime_ms(path)}

    try:
        created = await asyncio.to_thread(_create)
    except ValueError:
        return web.json_response({"error": "invalid document name"}, status=400)
    except FileExistsError:
        return web.json_response({"error": "document already exists"}, status=409)
    return web.json_response(created)


async def _handle_read_doc(request: web.Request) -> web.StreamResponse:
    name = request.query.get("name", "")

    def _read() -> dict[str, Any]:
        path = _safe_doc(name)
        if not path.is_file():
            raise FileNotFoundError(name)
        # Stat BEFORE read (md_notebook's ordering): a racing external write
        # surfaces as a save conflict later, never as silently stale content
        # paired with a fresh mtime token.
        mtime = _mtime_ms(path)
        return {
            "name": path.stem,
            "path": str(path),
            "content": path.read_text(encoding="utf-8", errors="replace"),
            "mtime": mtime,
        }

    try:
        doc = await asyncio.to_thread(_read)
    except ValueError:
        return web.json_response({"error": "invalid document name"}, status=400)
    except FileNotFoundError:
        return web.json_response({"error": "document not found"}, status=404)
    return web.json_response(doc)


async def _handle_save_doc(request: web.Request) -> web.StreamResponse:
    body = await _json_body(request)
    if body is None:
        return web.json_response({"error": "invalid body"}, status=400)
    name = str(body.get("name", ""))
    content = body.get("content")
    base_mtime = body.get("baseMtime")
    if not isinstance(content, str) or not isinstance(base_mtime, (int, float)):
        return web.json_response({"error": "content and baseMtime required"}, status=400)
    if len(content.encode("utf-8")) > _MAX_DOC_BYTES:
        return web.json_response({"error": "document too large"}, status=413)

    def _save() -> dict[str, Any]:
        path = _safe_doc(name)
        if not path.is_file():
            raise FileNotFoundError(name)
        if _mtime_ms(path) - float(base_mtime) > _MTIME_TOLERANCE_MS:
            raise TimeoutError(name)  # repurposed as the stale sentinel below
        atomic_write(path, content)
        # Stamp the mtime explicitly, strictly past the caller's base token.
        # Filesystem timestamp granularity can be coarse (10ms observed), so two
        # events inside one tick would otherwise share an mtime and a stale
        # writer racing within the tick would slip past the guard. The explicit
        # stamp makes every save advance the token deterministically.
        stamp = max(time.time(), (float(base_mtime) + 2 * _MTIME_TOLERANCE_MS) / 1000.0)
        os.utime(path, (stamp, stamp))
        return {"mtime": _mtime_ms(path), "saved_at": time.time()}

    try:
        result = await asyncio.to_thread(_save)
    except ValueError:
        return web.json_response({"error": "invalid document name"}, status=400)
    except FileNotFoundError:
        return web.json_response({"error": "document not found"}, status=404)
    except TimeoutError:
        return web.json_response(
            {"error": "document changed on disk since it was read", "code": "stale"},
            status=409,
        )
    return web.json_response(result)


def slots_file(root: Path | None = None) -> Path:
    """The JSON file mapping document name -> co-author chat slot key."""
    base = root if root is not None else app_data_dir(APP_NAME)
    return base / "coauthor-slots.json"


def _read_slots(root: Path | None = None) -> dict[str, str]:
    """Load the doc->slot mapping (missing or corrupt file reads as empty).

    Synchronous filesystem code — call from a worker thread.
    """
    path = slots_file(root)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return {k: v for k, v in raw.items() if isinstance(k, str) and isinstance(v, str)}


async def _handle_get_slot(request: web.Request) -> web.StreamResponse:
    name = request.query.get("name", "").strip()
    if not _NAME_RE.match(name) or ".." in name:
        return web.json_response({"error": "invalid document name"}, status=400)
    slots = await asyncio.to_thread(_read_slots)
    return web.json_response({"slot": slots.get(name)})


async def _handle_put_slot(request: web.Request) -> web.StreamResponse:
    body = await _json_body(request)
    if body is None:
        return web.json_response({"error": "invalid body"}, status=400)
    name = str(body.get("name", "")).strip()
    slot = str(body.get("slot", "")).strip()
    if not _NAME_RE.match(name) or ".." in name:
        return web.json_response({"error": "invalid document name"}, status=400)
    if not _SLOT_RE.match(slot):
        return web.json_response({"error": "invalid slot key"}, status=400)

    def _write() -> None:
        slots = _read_slots()
        slots[name] = slot
        path = slots_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        atomic_write(path, json.dumps(slots, indent=1, sort_keys=True))

    # The lock serializes the read-modify-write; the filesystem work still runs
    # off the event loop, and nothing awaits between read and write inside it.
    async with _slots_lock:
        await asyncio.to_thread(_write)
    return web.json_response({"ok": True})


def register_routes(app: web.Application) -> None:
    """Attach Scribe's routes to the gateway application (manifest entry point)."""
    app.router.add_get(f"{API_BASE}/docs", _require_enabled(_handle_list_docs))
    app.router.add_post(f"{API_BASE}/docs", _require_enabled(_handle_create_doc))
    app.router.add_get(f"{API_BASE}/doc", _require_enabled(_handle_read_doc))
    app.router.add_put(f"{API_BASE}/doc", _require_enabled(_handle_save_doc))
    app.router.add_get(f"{API_BASE}/slot", _require_enabled(_handle_get_slot))
    app.router.add_put(f"{API_BASE}/slot", _require_enabled(_handle_put_slot))
    logger.info("scribe routes registered at %s", API_BASE)
