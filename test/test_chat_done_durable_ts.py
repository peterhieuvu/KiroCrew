"""``chat_done`` and ``last_ts`` name only rows that survive a restart.

The client watermarks a background slot's unread badge with the ``chat_done``
frame's ``ts``, falling back to the slot's ``last_ts``. Both used to read the
turn-end ``done`` marker, which is never persisted: after a restart ``last_ts``
fell back to the final saved row, every read carried that older instant, and
the badge could never clear.
"""

import asyncio
from types import SimpleNamespace

from kiro_crew.dashboard.chat_utils import chat_done_payload, chat_done_ts
from kiro_crew.dashboard.state import _ChatSlot, durable_last_ts


def _finished_turn() -> _ChatSlot:
    slot = _ChatSlot("chat-1")
    slot.messages += [
        {"role": "user", "content": "go", "ts": "2026-09-16T02:23:40.000000+00:00"},
        {"role": "assistant", "content": "done", "ts": "2026-09-16T02:23:45.008011+00:00"},
        {"role": "done", "content": "", "ts": "2026-09-16T02:23:45.092644+00:00"},
    ]
    return slot


def test_durable_last_ts_skips_transient_rows():
    assert durable_last_ts(_finished_turn().messages) == "2026-09-16T02:23:45.008011+00:00"


def test_durable_last_ts_empty_window():
    assert durable_last_ts([]) == ""
    assert durable_last_ts([{"role": "done", "ts": "t1"}]) == ""


def test_chat_done_ts_omits_ts_for_empty_window():
    assert chat_done_ts(_ChatSlot("chat-1")) == {}


def test_chat_done_payload_carries_the_final_saved_row_ts():
    payload = asyncio.run(chat_done_payload(SimpleNamespace(), _finished_turn()))
    assert payload["ts"] == "2026-09-16T02:23:45.008011+00:00"


def test_last_ts_ignores_the_done_marker():
    d = _finished_turn().to_dict()
    assert d["last_ts"] == "2026-09-16T02:23:45.008011+00:00"


def test_last_ts_matches_after_a_restart():
    # A restart rebuilds the window from disk, where the marker never was.
    live = _finished_turn()
    restored = _ChatSlot("chat-1")
    restored.messages += [m for m in live.messages if m["role"] != "done"]
    assert live.to_dict()["last_ts"] == restored.to_dict()["last_ts"]
    assert chat_done_ts(live)["ts"] == restored.to_dict()["last_ts"]


def test_last_ts_still_advances_on_streamed_chunks():
    slot = _ChatSlot("chat-1")
    slot.messages += [
        {"role": "user", "content": "go", "ts": "t1"},
        {"role": "chunk", "content": "partial", "ts": "t2"},
    ]
    assert slot.to_dict()["last_ts"] == "t2"
