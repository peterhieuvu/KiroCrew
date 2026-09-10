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
| Context rail | `GET /api/knowledge/search-for-context?q=`, `GET /api/memory/semantic` — synchronous reads, no agent turn |

## Frontend

All under `website/src/apps/inkwell/`:

- `InkwellPage.tsx` — three panes (doc list, editor, co-author). Owns the
  autosave loop (debounced `saveDoc`, md-notebook's flush discipline:
  unmount-flush only when dirty, dirty-stays-on-failure), the conflict banner
  (a stale-token 409 keeps the stale token so retries fail loudly), the
  comment composer (posts an anchored comment, then a coalesced nudge into
  the bound session), and the document-creation popover (name + optional
  backing path, one pane). **Threads live at the passage**: a highlight
  click, a gutter marker, or the caret entering a range opens
  `ThreadPopover` beside the text; only orphaned threads (no live range)
  fall back to a list. **Comments are created at the passage too**: the
  Comment pill opens the composer as a popover at the selection (not a strip
  at the editor foot). One popover at a time: a RANGE selection anywhere
  closes an open thread popover (so the pill is never occluded and a fresh
  comment can be started inside an existing highlight), while a CARET inside
  a highlight opens its thread.
- **Show-resolved toggle**: resolved root threads are hidden by default; a
  header pill (`N resolved`) reveals them — decorated in a muted dashed
  style with hollow gutter dots — and their popover offers **Reopen**
  (`/reopen` endpoint). The open-count badge counts open threads only.
  `resolveThreads` does NOT filter by status; the page decides what to
  decorate.
- `ThreadPopover.tsx` — the anchored thread view: root, every reply with
  agent attribution and suggestion fences rendered as a preview block,
  status/orphan badges, Reply, and the human actions (Accept/Reject on a
  proposal, Resolve otherwise, Reopen when resolved). Closes on Escape,
  click-outside, or the caret leaving the range.
- `NewDocPopover.tsx` — replaces two native prompts with one pane.
- **Nudge coalescing**: comments post immediately (durability), but the
  agent nudge is a trailing 1.5 s debounce and is suppressed entirely while
  the bound session is busy; the busy→idle reload fires one catch-up nudge
  if anything was posted mid-turn. Rationale: a send into a running slot is
  QUEUED by the server as a whole extra turn, so N quick comments would cost
  N turns with the later ones finding nothing open.
- `RichMarkdownEditor.tsx` — Tiptap (open core, exact pins) WYSIWYG with
  markdown IO. External changes arrive via `setContent(..., emitUpdate:
  false)` so they never dirty the buffer; `setEditable(..., false)` for the
  same reason. Selecting text raises a Comment pill (settled on mouseup/keyup).
- `anchors.ts` — comment-anchor resolution: exact-offset fast path, then
  quote search with prefix/suffix disambiguation, orphan on miss. The text
  index mirrors quote construction (inline mark boundaries concatenate,
  block boundaries contribute one space, whitespace collapses).
  **Creation is symmetric**: `anchorForSelection` builds the FULL anchor
  (quote + 48 chars of prefix/suffix + offsets) on that same index, so a
  comment on the last of four identical lines resolves to the last line.
  Context scoring collapses whitespace but does not trim — the boundary
  space between prefix and quote is load-bearing. With no recorded offset
  the earliest hit is only the final stable tiebreak, never a bias toward
  the top of the document (legacy quote-only anchors keep their behaviour).
- `commentHighlights.ts` — ProseMirror decoration plugin: rebuilt when the
  page pushes freshly-resolved threads, mapped natively through user typing
  between pushes; clicks surface the thread id.
- `suggestions.ts` — proposed edits (phase 3): a proposal is a
  ` ```suggestion ` fence in a thread body (root or reply, latest wins);
  Accept re-resolves the root anchor at click time and splices the
  replacement as an ordinary edit (single-line = plain text, multi-line =
  markdown blocks), then replies and resolves; Reject replies and resolves.
  Accept/reject sit on the human-only resolve path by construction (surfaced in the thread popover).
- `ContextRail.tsx` — the synchronous context rail (phase 5): "what did we
  decide about X" answered with no agent turn. Derives a query from the
  document (selection, else H1 + the heading nearest the caret), then reads
  `GET /api/knowledge/search-for-context` for citation cards and
  `GET /api/memory/semantic` (fetched once per mount, filtered client-side
  by query terms — the same approach as the dashboard's own memory card;
  there is no server-side memory search). Debounced; stale responses
  dropped by request id. The co-author pane answers "help me write this";
  the rail answers "what do we already know" — two interactions, one surface.
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
never do. Interleaved edits get a **three-way merge** (`merge.ts`, line-based
on jsdiff, deliberately conservative): base is the content the buffer loaded
from, so all three sides exist client-side. Disjoint edits merge silently —
the result adopts into the still-dirty buffer and persists through the next
autosave, with an info banner. Overlapping edits refuse: the buffer AND the
stale concurrency token are kept, so the next save is refused loudly (409
banner with an explicit Reload) instead of silently overwriting either side.
Both the busy→idle reload and the save-time 409 route through the same merge.

Known limit: the server's comment-anchor rescan
(`_rescan_comment_anchors_locked` in `src/kiro_crew/artifacts.py`) checks
quotes against markdown source, while the editor resolves against rendered
text — a quote spanning inline formatting can be orphaned server-side yet
still resolvable in the editor. The orphan badge (popover and fallback list) shows the union of both verdicts.

## Tests

- `website/src/test/inkwellAnchors.test.ts` — anchor resolution and the
  markdown round-trip idempotency corpus, against a real headless Tiptap
  editor with the app's extension set; includes the repeated-lines
  regression (comment on the 4th of four identical lines stays there, and
  survives an edit above it).
- `website/src/test/InkwellPage.test.tsx` — autosave debounce, failure and
  conflict paths, thread popover, orphan fallback list, resolve/reopen
  wiring, Show-resolved toggle, caret-opens/selection-closes rule, nudge
  coalescing, comment-composer flow.
- `website/src/test/inkwellApi.test.ts` — `saveDoc` token/409 contract.
