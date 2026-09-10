/**
 * InkwellPage — markdown documents with an embedded agent co-author.
 *
 * Store rework (design doc: "Content management: the artifact store"):
 * documents are markdown-kind ARTIFACTS tagged `inkwell`. The app owns only
 * UI — storage, versions, anchored comments, and the doc↔session binding are
 * core artifact capabilities this page calls.
 *
 *   - Docs list  = GET /api/artifacts?tag=inkwell (main api client)
 *   - Autosave   = debounced PATCH `snapshot: false` (live state, no version
 *                  churn; md-notebook's flushSave discipline: unmount-flush,
 *                  dirty-stays-on-failure)
 *   - Snapshot   = explicit PATCH `snapshot: true` (numbered version)
 *   - Conflict   = #7818's `expected_sha256` token, capability-detected; the
 *                  token is held in a ref FROM EDIT START (its review lesson)
 *   - Session    = slot `artifact` binding at create; resolution filters the
 *                  live Redux slot list (ArtifactDetailPage's pickBoundSlot
 *                  rule) — no mapping store, survives browser profiles
 *   - Comments   = anchored artifact comments (quote anchor) + a nudge turn
 *                  into the co-author slot; the chat turn is the doorbell,
 *                  the comment thread is the durable record
 *
 * PROTOTYPE NOTE: user-facing strings are plain English pending i18n catalog
 * entries — a PR blocker, not a prototype blocker.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, Camera, FilePlus2, MessageSquareText, PenLine } from 'lucide-react'
import { useAppDispatch, useAppSelector } from '../../store'
import { addSlotOptimistic, fetchSlots } from '../../store/dashboardSlice'
import { selectComposerBusy } from '../../store/chatSlice'
import type { Artifact, ChatSlot } from '../../types'
import { api } from '../../api/client'
import RichMarkdownEditor, { type RichMarkdownEditorHandle } from './RichMarkdownEditor'
import CoAuthorPanel from './CoAuthorPanel'
import { companionContextLines } from './companionPrompt'
import { saveDoc, StaleDocError, INKWELL_TAG, type InkwellDoc } from './api'
import type { CommentThread } from './anchors'
import { parseSuggestion } from './suggestions'
import { threeWayMerge } from './merge'
import ContextRail from './ContextRail'
import ThreadPopover from './ThreadPopover'
import NewDocPopover from './NewDocPopover'

/** Map a top-level block index to its markdown source line. Blocks in the
 *  app's own serialization are separated by blank lines, so the Nth block
 *  starts at the Nth non-empty run — good enough to pick the nearest
 *  heading for the context rail's query. */
export function blockIndexToLine(markdown: string, blockIndex: number): number {
  const lines = markdown.split('\n')
  let block = -1
  let inBlock = false
  for (let i = 0; i < lines.length; i++) {
    const nonEmpty = lines[i].trim().length > 0
    if (nonEmpty && !inBlock) { block += 1; inBlock = true; if (block === blockIndex) return i }
    if (!nonEmpty) inBlock = false
  }
  return Math.max(0, lines.length - 1)
}

const AUTOSAVE_DEBOUNCE_MS = 800

/** The document's active companion session: the bound slot for `slug`, or the
 *  most recently active one if a race left more than one (ArtifactDetailPage's
 *  pickBoundSlot rule, verbatim). */
function pickBoundSlot(slots: ChatSlot[] | undefined, slug: string): ChatSlot | null {
  const matches = (slots ?? []).filter(s => s.artifact === slug)
  if (matches.length <= 1) return matches[0] ?? null
  return [...matches].sort((a, b) =>
    (b.last_activity_ts || '').localeCompare(a.last_activity_ts || ''))[0]
}

export default function InkwellPage() {
  const dispatch = useAppDispatch()

  const [docs, setDocs] = useState<Artifact[]>([])
  const [doc, setDoc] = useState<InkwellDoc | null>(null)
  const [buffer, setBuffer] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  // Phase-4 info signal: a clean 3-way merge folded the co-author's changes
  // into the user's draft. Cleared on the next successful save or doc open.
  const [merged, setMerged] = useState(false)
  const [chatOpen, setChatOpen] = useState(true)
  const [slotCreating, setSlotCreating] = useState(false)

  // ── Context rail (phase 5) ────────────────────────────────────────────────
  const [railOpen, setRailOpen] = useState(false)
  const [caretCtx, setCaretCtx] = useState<{ blockIndex: number; selection: string | null; threadId: string | null }>({ blockIndex: 0, selection: null, threadId: null })

  // ── Comment threads ───────────────────────────────────────────────────────
  // Fetched with the doc, refetched when the co-author turn ends and after a
  // send. `orphanedLocal` is the editor's own resolution verdict, unioned
  // with the server's `anchor_orphaned` in the strip.
  const [threads, setThreads] = useState<CommentThread[]>([])
  const [orphanedLocal, setOrphanedLocal] = useState<string[]>([])
  // The thread whose popover is open, anchored at its passage. Opens on a
  // highlight click, a gutter marker click, or the caret entering a range;
  // closes when the caret leaves, on Escape, or on click-outside.
  const [focusThread, setFocusThread] = useState<string | null>(null)
  // Caret-follow: a CARET inside a highlight opens its thread; a RANGE
  // selection anywhere closes it — the user is about to comment (the pill
  // needs the space and must not be occluded), so a fresh comment can be
  // started inside an existing highlight. Caret leaving all highlights closes.
  useEffect(() => {
    if (caretCtx.selection !== null) setFocusThread(null)
    else if (caretCtx.threadId) setFocusThread(caretCtx.threadId)
    else setFocusThread(null)
  }, [caretCtx])

  const fetchThreads = useCallback(async (slug: string) => {
    try {
      const res = (await api.artifactComments(slug)) as { comments: CommentThread[] }
      setThreads(res.comments)
    } catch {
      // Comments are an overlay; a fetch failure must not block writing.
    }
  }, [])

  // ── Concurrency token (#7818) ────────────────────────────────────────────
  // Held in a REF, captured when the loaded content was read — NOT re-derived
  // at save time. Re-reading it from state at save time was the bug #7818's
  // own review caught: a reload between edit start and save would rebase the
  // token and let the save silently clobber what changed underneath.
  const baseShaRef = useRef<string | null>(null)

  // ── Session binding: derived, not stored ─────────────────────────────────
  const slots = useAppSelector(s => s.dashboard.slots)
  const slotKey = useMemo(
    () => (doc ? pickBoundSlot(slots, doc.slug)?.key ?? null : null),
    [slots, doc],
  )

  const refreshDocs = useCallback(async () => {
    try {
      const res = (await api.artifacts({ tag: INKWELL_TAG })) as { artifacts: Artifact[] }
      setDocs(res.artifacts)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => { void refreshDocs() }, [refreshDocs])

  const openDoc = useCallback(async (slug: string) => {
    try {
      const d = (await api.artifact(slug)) as InkwellDoc
      setDoc(d)
      setBuffer(d.content ?? '')
      baseShaRef.current = d.content_sha256 ?? null
      setDirty(false)
      setConflict(false)
      setError(null)
      setMerged(false)
      setFocusThread(null)
      void fetchThreads(slug)
      // No session lookup: `slotKey` derives from the Redux slot list via the
      // slot's own `artifact` binding, which the WS slots event keeps fresh.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [fetchThreads])

  const [newDocOpen, setNewDocOpen] = useState(false)
  const createDoc = useCallback(async (name: string, sourcePath: string | undefined) => {
    try {
      const created = (await api.createArtifact({
        name,
        kind: 'markdown',
        content: `# ${name}\n`,
        tags: [INKWELL_TAG],
        ...(sourcePath ? { source_path: sourcePath } : {}),
      })) as { slug: string }
      setNewDocOpen(false)
      await refreshDocs()
      await openDoc(created.slug)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [refreshDocs, openDoc])

  // ── Autosave: debounced flushSave (md-notebook's discipline) ──────────────
  // One in-flight save at a time; the debounce and any explicit flush share
  // `flushSave` so they can't double-write. On failure `dirty` STAYS set —
  // the next keystroke or unmount retries; a conflict raises the banner.
  const bufferRef = useRef(buffer)
  bufferRef.current = buffer
  const docRef = useRef(doc)
  docRef.current = doc
  const savingRef = useRef(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushSave = useCallback(async (snapshot = false): Promise<boolean> => {
    const d = docRef.current
    if (!d || savingRef.current) return false
    savingRef.current = true
    setSaving(true)
    const content = bufferRef.current
    try {
      const res = await saveDoc(d.slug, content, {
        expectedSha256: baseShaRef.current,
        snapshot,
      })
      baseShaRef.current = res.contentSha256
      // Only clear dirty if the buffer didn't move during the await — a
      // keystroke mid-flight means there is newer unsaved content.
      if (bufferRef.current === content) setDirty(false)
      setConflict(false)
      setMerged(false)
      return true
    } catch (e) {
      if (e instanceof StaleDocError) {
        // Interleaved edits caught at save time (phase 4): someone changed
        // the doc under us. Fetch theirs and try the same 3-way merge as
        // the busy→idle path; one retry, then the loud banner.
        try {
          const fresh = (await api.artifact(d.slug)) as InkwellDoc
          const m = threeWayMerge(d.content ?? '', bufferRef.current, fresh.content ?? '')
          if (m.clean) {
            setDoc(fresh)
            baseShaRef.current = fresh.content_sha256 ?? null
            setBuffer(m.merged)
            setDirty(true)
            setConflict(false)
            setMerged(true)
            // Arm the autosave so the merged state persists without waiting
            // for a keystroke (savingRef clears in finally before it fires).
            if (debounceRef.current) clearTimeout(debounceRef.current)
            debounceRef.current = setTimeout(() => { void flushSave(false) }, AUTOSAVE_DEBOUNCE_MS)
            return false
          }
        } catch { /* fall through to the banner */ }
        // Overlap (or the refetch failed): keep the stale token so every
        // retry keeps failing loudly until the user reloads or adopts.
        setConflict(true)
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
      return false
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }, [])

  const onEdit = useCallback((md: string) => {
    setBuffer(md)
    setDirty(true)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => { void flushSave(false) }, AUTOSAVE_DEBOUNCE_MS)
  }, [flushSave])

  // Unmount / doc-switch flush: pending debounce collapses into one final
  // save — but ONLY when there is unsaved work. Unconditional flushing made
  // every doc OPEN fire a save of just-loaded content (the effect re-runs on
  // the null→slug transition and its cleanup ran flushSave) — caught by
  // InkwellPage.test.tsx's "not called yet" assertion.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      if (dirtyRef.current) void flushSave(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.slug])

  /** Adopt the server copy, dropping the buffer (explicit user choice). */
  const reloadFromServer = useCallback(async () => {
    if (!doc) return
    await openDoc(doc.slug)
  }, [doc, openDoc])

  // Cmd/Ctrl+S = snapshot (autosave already persists live state continuously).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        void flushSave(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [flushSave])

  // ── Co-author session lifecycle ───────────────────────────────────────────
  const startSession = useCallback(async (): Promise<string | null> => {
    if (!doc || slotCreating) return null
    setSlotCreating(true)
    try {
      // Stock slot (no agent/model/memory_mode override), bound to the
      // artifact at create — the 8th argument. The binding is the entire
      // persistence story: it rides the slot into history meta and the WS
      // slots event, so `pickBoundSlot` reattaches from any browser.
      const created = await api.createChatSlot(
        undefined, undefined, undefined, undefined, undefined,
        `Inkwell: ${doc.name}`, undefined, doc.slug,
      )
      const key = created.key as string
      dispatch(addSlotOptimistic({
        key,
        title: created.title || doc.name,
        messages: 0,
        running: false,
        artifact: doc.slug,
      } as ChatSlot))
      api.chatSlotContext(
        key,
        companionContextLines(doc.name, doc.slug, doc.source_path ?? null).join('\n'),
        { source: 'inkwell-co-author', ephemeral: true },
      ).catch(() => undefined)
      dispatch(fetchSlots())
      return key
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      setSlotCreating(false)
    }
  }, [doc, slotCreating, dispatch])

  // ── busy→idle reload (papyrus's no-flush rule, on the artifact read) ──────
  const coAuthorBusy = useAppSelector(state => selectComposerBusy(state, slotKey))
  const busyRef = useRef(coAuthorBusy)
  busyRef.current = coAuthorBusy

  // ── Nudge coalescer ───────────────────────────────────────────────────────
  // Comments post immediately (durability); nudges are the doorbell and are
  // cheap to over-ring but expensive when they land: a send into a running
  // slot QUEUES a whole extra turn (the server fail-closes to the queue), so
  // three quick comments would cost three turns, the last two finding
  // nothing open. Rules: trailing debounce while idle; while the co-author is
  // busy, just flag — the busy→idle effect fires ONE catch-up nudge.
  const nudgeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const nudgePendingRef = useRef(false)
  const NUDGE_DEBOUNCE_MS = 1500
  const fireNudge = useCallback(async () => {
    nudgePendingRef.current = false
    const key = slotKey ?? await startSession()
    if (!key) return
    const msg =
      'New comment activity on the document we are co-authoring. '
      + 'Read the open comment threads with artifact_get_comments and '
      + 'address any you have not already handled: act on each, reply on the '
      + 'thread, and advance it with artifact_mark_review.'
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)
    try {
      const r = await api.sendChat(msg, key, undefined, controller.signal)
      if (!r.ok) throw new Error(`Send failed (${r.status})`)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      clearTimeout(timeout)
    }
  }, [slotKey, startSession])
  const scheduleNudge = useCallback(() => {
    nudgePendingRef.current = true
    if (busyRef.current) return // the busy→idle effect will fire it
    if (nudgeTimerRef.current) clearTimeout(nudgeTimerRef.current)
    nudgeTimerRef.current = setTimeout(() => {
      nudgeTimerRef.current = null
      if (nudgePendingRef.current && !busyRef.current) void fireNudge()
    }, NUDGE_DEBOUNCE_MS)
  }, [fireNudge])
  const prevBusyRef = useRef(false)
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  useEffect(() => {
    const wasBusy = prevBusyRef.current
    prevBusyRef.current = coAuthorBusy
    if (!wasBusy || coAuthorBusy || !slotKey || !doc) return
    void (async () => {
      try {
        const fresh = (await api.artifact(doc.slug)) as InkwellDoc
        if (dirtyRef.current) {
          if ((fresh.content ?? '') === bufferRef.current) {
            // Buffer already matches the server (agent made no change, or the
            // user typed exactly it): adopt cleanly, token included.
            setDoc(fresh)
            baseShaRef.current = fresh.content_sha256 ?? null
            setDirty(false)
            setConflict(false)
          } else {
            // Interleaved edits (phase 4): the user typed during the agent's
            // turn. Try a 3-way merge — base is the content this buffer was
            // loaded from, all three sides are already in hand.
            const m = threeWayMerge(doc.content ?? '', bufferRef.current, fresh.content ?? '')
            if (m.clean) {
              // Adopt the merge INTO THE BUFFER (stays dirty): the armed
              // autosave persists it against the fresh token, so the merged
              // state becomes server truth through the normal path.
              setDoc(fresh)
              baseShaRef.current = fresh.content_sha256 ?? null
              setBuffer(m.merged)
              setDirty(true)
              setConflict(false)
              setMerged(true)
              if (debounceRef.current) clearTimeout(debounceRef.current)
              debounceRef.current = setTimeout(() => { void flushSave(false) }, AUTOSAVE_DEBOUNCE_MS)
            } else {
              // Overlapping edits: keep the buffer AND the stale token — the
              // next autosave 409s loudly instead of silently overwriting
              // the agent's edit. The banner is the conflict UI.
              setConflict(true)
            }
          }
        } else {
          setDoc(fresh)
          setBuffer(fresh.content ?? '')
          baseShaRef.current = fresh.content_sha256 ?? null
        }
        // The turn may have replied to / advanced threads: refresh them.
        void fetchThreads(doc.slug)
        // Comments posted DURING the turn were held; one catch-up nudge now.
        if (nudgePendingRef.current) scheduleNudge()
      } catch {
        // A refresh failure is not worth a banner: the next autosave recovers,
        // and surfacing it would blame the user for the agent's turn.
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coAuthorBusy, slotKey, doc?.slug])

  const toggleChat = useCallback(() => {
    setChatOpen(open => {
      if (!open && !slotKey) void startSession()
      return !open
    })
  }, [slotKey, startSession])

  // ── highlight → anchored comment → nudge turn ────────────────────────────
  // The comment is the durable record (thread, REVIEW/resolve lifecycle,
  // server-side orphan rescan on every content write); the chat turn is the
  // doorbell that makes the co-author act on it now.
  const [commentQuote, setCommentQuote] = useState<string | null>(null)
  const [commentAt, setCommentAt] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const [commentNote, setCommentNote] = useState('')
  const [commentSending, setCommentSending] = useState(false)

  const sendComment = useCallback(async () => {
    if (!doc || !commentQuote || !commentNote.trim() || commentSending) return
    setCommentSending(true)
    try {
      // Durability first: the comment lands on the artifact immediately.
      await api.postArtifactComment(doc.slug, {
        text: commentNote.trim(),
        anchor: { quote: commentQuote },
      })
      // The nudge is coalesced (see scheduleNudge): N quick comments → one
      // turn; comments posted mid-turn → one catch-up nudge at busy→idle.
      scheduleNudge()
      setCommentQuote(null)
      setCommentNote('')
      setChatOpen(true)
      void fetchThreads(doc.slug)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCommentSending(false)
    }
  }, [doc, commentQuote, commentNote, commentSending, scheduleNudge, fetchThreads])

  const replyToThread = useCallback(async (root: CommentThread, text: string) => {
    if (!doc) return
    try {
      await api.replyArtifactComment(doc.slug, root.id, { text })
      scheduleNudge()
      void fetchThreads(doc.slug)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [doc, scheduleNudge, fetchThreads])

  const resolveThread = useCallback(async (id: string) => {
    if (!doc) return
    try {
      await api.resolveComment(doc.slug, id)
      void fetchThreads(doc.slug)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [doc, fetchThreads])

  const reopenThread = useCallback(async (id: string) => {
    if (!doc) return
    try {
      await api.reopenComment(doc.slug, id)
      void fetchThreads(doc.slug)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [doc, fetchThreads])

  // Root threads. `openRoots` drives the badge count and nudging; `visibleRoots`
  // is what gets decorated and listed — resolved ones only when the toggle is
  // on (default off: done threads should not clutter the passage).
  const [showResolved, setShowResolved] = useState(false)
  const openRoots = useMemo(
    () => threads.filter(t => !t.parent_id && t.status !== 'resolved'),
    [threads],
  )
  const rootThreads = useMemo(
    () => (showResolved ? threads.filter(t => !t.parent_id) : openRoots),
    [threads, openRoots, showResolved],
  )
  const resolvedCount = useMemo(
    () => threads.filter(t => !t.parent_id && t.status === 'resolved').length,
    [threads],
  )
  const isOrphaned = useCallback(
    (t: CommentThread) => !!t.anchor_orphaned || orphanedLocal.includes(t.id),
    [orphanedLocal],
  )
  const focusedRoot = useMemo(
    () => (focusThread ? rootThreads.find(t => t.id === focusThread) ?? null : null),
    [focusThread, rootThreads],
  )

  // ── Proposed edits (phase 3) ──────────────────────────────────────────────
  // A thread carries a proposal when its root or any reply holds a
  // ```suggestion fence; the LATEST fence wins (the co-author may revise).
  // The anchor is always the root's — that is what the proposal replaces.
  const editorRef = useRef<RichMarkdownEditorHandle>(null)
  const suggestionFor = useMemo(() => {
    const map = new Map<string, string>()
    for (const root of rootThreads) {
      const chain = [root, ...threads.filter(t => t.parent_id === root.id)]
      for (const c of chain) {
        const s = parseSuggestion(c.body)
        if (s !== null) map.set(root.id, s) // later entries overwrite: latest wins
      }
    }
    return map
  }, [rootThreads, threads])

  const acceptSuggestion = useCallback(async (root: CommentThread) => {
    const replacement = suggestionFor.get(root.id)
    if (!doc || !root.anchor || replacement === undefined) return
    const applied = editorRef.current?.applySuggestion(root.anchor, replacement)
    if (!applied) {
      setError('Could not apply: the anchored passage no longer exists. Reject the proposal or re-anchor it.')
      return
    }
    // The splice flowed through onChange → autosave. Record the decision on
    // the thread, then close it — accept IS the human resolve.
    try {
      await api.replyArtifactComment(doc.slug, root.id, { text: 'Applied the suggestion.' })
      await api.resolveComment(doc.slug, root.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    void fetchThreads(doc.slug)
  }, [doc, suggestionFor, fetchThreads])

  const rejectSuggestion = useCallback(async (root: CommentThread) => {
    if (!doc) return
    try {
      await api.replyArtifactComment(doc.slug, root.id, { text: 'Declined the suggestion.' })
      await api.resolveComment(doc.slug, root.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
    void fetchThreads(doc.slug)
  }, [doc, fetchThreads])

  return (
    <div className="flex h-full min-h-0 overflow-hidden" data-testid="inkwell-page">
      {/* Document list */}
      <aside className="relative w-52 shrink-0 border-r border-border bg-card flex flex-col min-h-0">
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border shrink-0">
          <PenLine className="lucide-inline text-accent" />
          <span className="flex-1 text-[13px] font-semibold text-text">Inkwell</span>
          <button
            type="button"
            onClick={() => setNewDocOpen(o => !o)}
            title="New document"
            aria-label="New document"
            className="p-1 rounded text-muted hover:text-text hover:bg-bg-hover cursor-pointer bg-transparent border-none transition-colors"
          >
            <FilePlus2 className="lucide-inline" />
          </button>
          {newDocOpen && <NewDocPopover onCreate={createDoc} onClose={() => setNewDocOpen(false)} />}
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {docs.length === 0 && (
            <div className="px-3 py-2 text-[12px] text-muted">No documents yet.</div>
          )}
          {docs.map(d => (
            <button
              key={d.slug}
              type="button"
              onClick={() => void openDoc(d.slug)}
              className={`w-full text-left px-3 py-1.5 text-[13px] truncate cursor-pointer bg-transparent border-none transition-colors ${
                doc?.slug === d.slug ? 'text-accent bg-bg-hover' : 'text-text hover:bg-bg-hover'
              }`}
            >
              {d.name}
            </button>
          ))}
        </div>
      </aside>

      {/* Editor */}
      <main className="flex-1 min-w-0 flex flex-col min-h-0">
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border shrink-0">
          <span className="flex-1 truncate text-[13px] text-text">
            {doc ? doc.name : 'Select or create a document'}
            {dirty ? ' •' : saving ? ' ⋯' : ''}
          </span>
          {doc && openRoots.length > 0 && (
            <span
              className="text-[11px] rounded-full bg-accent/15 text-accent px-2 py-0.5"
              title={`${openRoots.length} open comment thread${openRoots.length === 1 ? '' : 's'} — click a highlight or gutter dot to open one`}
              data-testid="inkwell-thread-count"
            >
              {openRoots.length} {openRoots.length === 1 ? 'thread' : 'threads'}
            </span>
          )}
          {doc && resolvedCount > 0 && (
            <button
              type="button"
              onClick={() => setShowResolved(v => !v)}
              aria-pressed={showResolved}
              title={showResolved ? 'Hide resolved threads' : `Show ${resolvedCount} resolved thread${resolvedCount === 1 ? '' : 's'}`}
              className={`text-[11px] rounded-full px-2 py-0.5 border cursor-pointer transition-colors ${
                showResolved ? 'bg-bg-hover text-text border-border' : 'bg-transparent text-muted border-border/60 hover:text-text'
              }`}
              data-testid="inkwell-show-resolved"
            >
              {showResolved ? 'Hide resolved' : `${resolvedCount} resolved`}
            </button>
          )}
          {merged && !conflict && (
            <span className="text-[12px] text-success">
              Merged the co-author’s changes into your draft.
            </span>
          )}
          {conflict && (
            <span className="text-[12px] text-danger flex items-center gap-2">
              Changed on the server.
              <button
                type="button"
                onClick={() => void reloadFromServer()}
                className="underline cursor-pointer bg-transparent border-none text-danger"
              >
                Reload
              </button>
            </span>
          )}
          <button
            type="button"
            onClick={() => void flushSave(true)}
            disabled={!doc}
            title="Snapshot a numbered version (Cmd/Ctrl+S). Autosave already persists continuously."
            className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-elevated px-2 py-1 text-[12px] text-text hover:bg-bg-hover cursor-pointer disabled:opacity-50 disabled:cursor-default transition-colors"
          >
            <Camera className="lucide-inline" /> Snapshot
          </button>
          <button
            type="button"
            onClick={() => setRailOpen(o => !o)}
            disabled={!doc}
            title={railOpen ? 'Hide context' : 'Show related knowledge and memory (no agent turn)'}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-elevated px-2 py-1 text-[12px] text-text hover:bg-bg-hover cursor-pointer disabled:opacity-50 disabled:cursor-default transition-colors"
          >
            <BookOpen className="lucide-inline" /> Context
          </button>
          <button
            type="button"
            onClick={toggleChat}
            title={chatOpen ? 'Hide co-author' : 'Show co-author'}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-elevated px-2 py-1 text-[12px] text-text hover:bg-bg-hover cursor-pointer transition-colors"
          >
            <MessageSquareText className="lucide-inline" /> Co-author
          </button>
        </div>
        {error && (
          <div className="px-3 py-1 text-[12px] text-danger border-b border-border shrink-0">{error}</div>
        )}
        <div className="relative flex-1 min-h-0">
          {doc ? (
            <RichMarkdownEditor
              ref={editorRef}
              value={buffer}
              onChange={onEdit}
              onComment={(quote, at) => {
                setCommentQuote(quote)
                setCommentAt(at)
                setCommentNote('')
                setFocusThread(null) // one popover at a time
              }}
              commentThreads={rootThreads}
              onThreadsResolved={setOrphanedLocal}
              onThreadClick={setFocusThread}
              onCaretContext={setCaretCtx}
            />
          ) : (
            <div className="h-full flex items-center justify-center text-[13px] text-muted">
              Open a document to start writing.
            </div>
          )}
          {focusedRoot && !commentQuote && (
            <ThreadPopover
              key={focusedRoot.id}
              root={focusedRoot}
              replies={threads.filter(t => t.parent_id === focusedRoot.id)}
              suggestion={suggestionFor.get(focusedRoot.id)}
              orphaned={isOrphaned(focusedRoot)}
              anchor={editorRef.current?.threadAnchorRect(focusedRoot.id) ?? null}
              onAccept={() => void acceptSuggestion(focusedRoot)}
              onReject={() => void rejectSuggestion(focusedRoot)}
              onResolve={() => void resolveThread(focusedRoot.id)}
              onReopen={() => void reopenThread(focusedRoot.id)}
              onReply={text => replyToThread(focusedRoot, text)}
              onClose={() => setFocusThread(null)}
            />
          )}
          {/* Comment composer — at the selection, where the pill was, not at
              the bottom of the editor. Escape or Cancel dismisses; Enter sends. */}
          {commentQuote && (
            <div
              role="dialog"
              aria-label="New comment"
              data-testid="inkwell-comment-composer"
              className="absolute z-20 w-[340px] rounded-lg border border-border bg-bg-elevated shadow-lg p-2.5 flex flex-col gap-1.5 text-[12px]"
              style={{ left: Math.max(0, commentAt.x - 20), top: commentAt.y + 4 }}
            >
              <div className="text-muted truncate italic" title={commentQuote}>
                “{commentQuote.length > 120 ? `${commentQuote.slice(0, 120)}…` : commentQuote}”
              </div>
              <input
                value={commentNote}
                onChange={e => setCommentNote(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') void sendComment()
                  if (e.key === 'Escape') setCommentQuote(null)
                }}
                // eslint-disable-next-line jsx-a11y/no-autofocus -- opens from an
                // explicit pill click; focus continues that gesture.
                autoFocus
                aria-label="Comment for the co-author"
                placeholder="Ask a question or request an edit…"
                className="w-full rounded-md border border-border bg-bg px-2 py-1 text-[13px] text-text outline-none focus-ring"
              />
              <div className="flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => setCommentQuote(null)}
                  className="rounded-md px-2 py-1 text-[12px] text-muted hover:text-text cursor-pointer bg-transparent border-none transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void sendComment()}
                  disabled={!commentNote.trim() || commentSending}
                  className="rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1 text-[12px] text-accent hover:bg-accent/20 cursor-pointer disabled:opacity-50 disabled:cursor-default transition-colors"
                >
                  {commentSending ? 'Sending…' : 'Comment & notify'}
                </button>
              </div>
            </div>
          )}
        </div>
        {/* Orphaned threads have no passage to sit at — list them here so they
            stay reachable; everything anchored lives in the popover instead. */}
        {rootThreads.some(isOrphaned) && (
          <div className="border-t border-border shrink-0 max-h-28 overflow-y-auto" data-testid="inkwell-orphaned-threads">
            {rootThreads.filter(isOrphaned).map(t => (
              <button
                key={t.id}
                type="button"
                onClick={() => setFocusThread(t.id)}
                className={`w-full text-left flex items-center gap-2 px-3 py-1.5 text-[12px] border-b border-border/50 last:border-b-0 cursor-pointer bg-transparent border-x-0 border-t-0 hover:bg-bg-hover ${
                  focusThread === t.id ? 'bg-bg-hover' : ''
                }`}
              >
                <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide bg-warn/15 text-warn" title="The anchored passage no longer exists in the document">orphaned</span>
                <span className="flex-1 truncate text-text" title={t.body}>{t.is_agent ? '🤖 ' : ''}{t.body}</span>
              </button>
            ))}
          </div>
        )}
      </main>

      {/* Context rail — synchronous, no agent turn */}
      {railOpen && doc && (
        <ContextRail
          markdown={buffer}
          caretLine={blockIndexToLine(buffer, caretCtx.blockIndex)}
          selection={caretCtx.selection}
          onClose={() => setRailOpen(false)}
        />
      )}

      {/* Co-author */}
      {chatOpen && doc && (
        <div className="w-[380px] shrink-0 min-h-0">
          <CoAuthorPanel
            slotKey={slotKey}
            creating={slotCreating}
            onStartSession={startSession}
            onClose={() => setChatOpen(false)}
          />
        </div>
      )}
    </div>
  )
}
