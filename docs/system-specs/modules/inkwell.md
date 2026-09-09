# Inkwell Module

## Overview

Inkwell is an opt-in (`defaultEnabled: false`) built-in app: a rich markdown
editor with an embedded AI co-author. Documents are **markdown-kind artifacts
tagged `inkwell`** — the app owns only UI, while storage, versions, anchored
comments, and the document↔session binding are core artifact capabilities it
calls. A document can be file-backed (`source_path`), in which case the store
writes through to the real `.md` file on disk, keeping it portable, diffable,
and readable by any editor.

The co-author panel is a real KiroCrew chat session bound to the artifact, so
the agent brings the user's memory, knowledge library, and codebase context to
the draft, edits the document with the globally-mounted artifact tools, and
the editor picks the change up when the turn finishes — without discarding the
user's unsaved typing.

## No backend

This app registers **no routes**: `apps/builtins/inkwell/__init__.py`
deliberately exports no `register_routes` (the startup loop in
`dashboard/server.py` checks `hasattr` and skips it). Everything the page
calls is a core endpoint:

| Concern | Core surface |
|---|---|
| List / read / create documents | `GET /api/artifacts?tag=inkwell`, `GET /api/artifacts/{slug}`, `POST /api/artifacts` (handlers in `src/kiro_crew/dashboard/handlers/artifacts.py`) |
| Save | `PATCH /api/artifacts/{slug}` — `snapshot: false` for autosave (live state, no version bump), `snapshot: true` for an explicit checkpoint |
| Concurrency | `expected_sha256` optimistic-concurrency token when the gateway supplies `content_sha256`; capability-detected, last-write-wins otherwise |
| Comments | `GET/POST /api/artifacts/{slug}/comments`, `/{id}/resolve` (resolve is human-only, enforced server-side) |
| Co-author session | `POST /api/chat/slots` with the `artifact` binding; ephemeral scoping note via `POST /api/chat/slots/{key}/context` |

## Frontend

All under `website/src/apps/inkwell/`:

- `InkwellPage.tsx` — three panes (doc list, editor, co-author). Owns the
  autosave loop (debounced `saveDoc`, md-notebook's flush discipline:
  unmount-flush only when dirty, dirty-stays-on-failure), the conflict banner
  (a stale-token 409 keeps the stale token so retries fail loudly), the
  threads strip (status chips, orphan badge, human-only Resolve), and the
  comment composer (posts an anchored comment, then a nudge turn into the
  bound session).
- `RichMarkdownEditor.tsx` — Tiptap (open core, exact pins) WYSIWYG with
  markdown IO. External changes arrive via `setContent(..., emitUpdate:
  false)` so they never dirty the buffer; `setEditable(..., false)` for the
  same reason. Selecting text raises a Comment pill (settled on mouseup/keyup).
- `anchors.ts` — comment-anchor resolution: exact-offset fast path, then
  quote search with prefix/suffix disambiguation, orphan on miss. The text
  index mirrors quote construction (inline mark boundaries concatenate,
  block boundaries contribute one space, whitespace collapses).
- `commentHighlights.ts` — ProseMirror decoration plugin: rebuilt when the
  page pushes freshly-resolved threads, mapped natively through user typing
  between pushes; clicks surface the thread id.
- `suggestions.ts` — proposed edits (phase 3): a proposal is a
  ` ```suggestion ` fence in a thread body (root or reply, latest wins);
  Accept re-resolves the root anchor at click time and splices the
  replacement as an ordinary edit (single-line = plain text, multi-line =
  markdown blocks), then replies and resolves; Reject replies and resolves.
  Accept/reject sit on the human-only resolve path by construction.
- `api.ts` — one raw call, `saveDoc`, kept off the shared client for precise
  409 handling; everything else uses `website/src/api/client.ts`.
- `companionPrompt.ts` — the ephemeral scoping note: names the artifact slug,
  teaches the artifact tools (`artifact_get` / `artifact_update`) and the
  comment protocol (reply, `artifact_mark_review`, never resolve).

## Session binding

The co-author slot carries a first-class `artifact` field set at creation
(`createChatSlot` in `website/src/api/client.ts`); the page resolves the
bound session by filtering the live Redux slot list (`pickBoundSlot` in
`InkwellPage.tsx`, the same rule as `ArtifactDetailPage.tsx`). There is no
mapping store: the binding survives browser profiles, and a deleted session
degrades to "Start a session" because it is simply absent from the list.

## Conflict model

Agent edits always create a version snapshot (store behavior); user autosaves
never do. When the user typed during an agent turn, the busy→idle reload
keeps the user's buffer AND the stale concurrency token, so the next save is
refused loudly (409 banner with an explicit Reload) instead of silently
overwriting the agent's edit.

Known limit: the server's comment-anchor rescan
(`_rescan_comment_anchors_locked` in `src/kiro_crew/artifacts.py`) checks
quotes against markdown source, while the editor resolves against rendered
text — a quote spanning inline formatting can be orphaned server-side yet
still resolvable in the editor. The strip shows the union of both verdicts.

## Tests

- `website/src/test/inkwellAnchors.test.ts` — anchor resolution and the
  markdown round-trip idempotency corpus, against a real headless Tiptap
  editor with the app's extension set.
- `website/src/test/InkwellPage.test.tsx` — autosave debounce, failure and
  conflict paths, threads strip, resolve wiring, comment-composer flow.
- `website/src/test/inkwellApi.test.ts` — `saveDoc` token/409 contract.
