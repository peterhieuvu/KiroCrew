/**
 * ScribePage — markdown documents with an embedded agent co-author.
 *
 * Store rework (design doc: "Content management: the artifact store"):
 * documents are markdown-kind ARTIFACTS tagged `scribe`. The app owns only
 * UI — storage, versions, anchored comments, and the doc↔session binding are
 * core artifact capabilities this page calls.
 *
 *   - Docs list  = GET /api/artifacts?tag=scribe (main api client)
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
import { Camera, FilePlus2, MessageSquareText, PenLine } from 'lucide-react'
import { useAppDispatch, useAppSelector } from '../../store'
import { addSlotOptimistic, fetchSlots } from '../../store/dashboardSlice'
import { selectComposerBusy } from '../../store/chatSlice'
import type { Artifact, ChatSlot } from '../../types'
import { api } from '../../api/client'
import RichMarkdownEditor, { type RichMarkdownEditorHandle } from './RichMarkdownEditor'
import CoAuthorPanel from './CoAuthorPanel'
import { companionContextLines } from './companionPrompt'
import { saveDoc, StaleDocError, SCRIBE_TAG, type ScribeDoc } from './api'
import type { CommentThread } from './anchors'
import { parseSuggestion } from './suggestions'

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

export default function ScribePage() {
  const dispatch = useAppDispatch()

  const [docs, setDocs] = useState<Artifact[]>([])
  const [doc, setDoc] = useState<ScribeDoc | null>(null)
  const [buffer, setBuffer] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [chatOpen, setChatOpen] = useState(true)
  const [slotCreating, setSlotCreating] = useState(false)

  // ── Comment threads ───────────────────────────────────────────────────────
  // Fetched with the doc, refetched when the co-author turn ends and after a
  // send. `orphanedLocal` is the editor's own resolution verdict, unioned
  // with the server's `anchor_orphaned` in the strip.
  const [threads, setThreads] = useState<CommentThread[]>([])
  const [orphanedLocal, setOrphanedLocal] = useState<string[]>([])
  const [focusThread, setFocusThread] = useState<string | null>(null)

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
      const res = (await api.artifacts({ tag: SCRIBE_TAG })) as { artifacts: Artifact[] }
      setDocs(res.artifacts)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => { void refreshDocs() }, [refreshDocs])

  const openDoc = useCallback(async (slug: string) => {
    try {
      const d = (await api.artifact(slug)) as ScribeDoc
      setDoc(d)
      setBuffer(d.content ?? '')
      baseShaRef.current = d.content_sha256 ?? null
      setDirty(false)
      setConflict(false)
      setError(null)
      setFocusThread(null)
      void fetchThreads(slug)
      // No session lookup: `slotKey` derives from the Redux slot list via the
      // slot's own `artifact` binding, which the WS slots event keeps fresh.
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [fetchThreads])

  const createDoc = useCallback(async () => {
    const name = window.prompt('Document name:')
    if (!name) return
    const sourcePath = window.prompt(
      'File path to back it (optional — blank keeps it store-only):',
    ) || undefined
    try {
      const created = (await api.createArtifact({
        name,
        kind: 'markdown',
        content: `# ${name}\n`,
        tags: [SCRIBE_TAG],
        ...(sourcePath ? { source_path: sourcePath } : {}),
      })) as { slug: string }
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
      return true
    } catch (e) {
      if (e instanceof StaleDocError) {
        // Someone else (another window, the co-author via a path we didn't
        // observe) changed the doc under us. Keep the stale token so every
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
  // ScribePage.test.tsx's "not called yet" assertion.
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
        `Scribe: ${doc.name}`, undefined, doc.slug,
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
        { source: 'scribe-co-author', ephemeral: true },
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
  const prevBusyRef = useRef(false)
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  useEffect(() => {
    const wasBusy = prevBusyRef.current
    prevBusyRef.current = coAuthorBusy
    if (!wasBusy || coAuthorBusy || !slotKey || !doc) return
    void (async () => {
      try {
        const fresh = (await api.artifact(doc.slug)) as ScribeDoc
        if (dirtyRef.current) {
          if ((fresh.content ?? '') === bufferRef.current) {
            // Buffer already matches the server (agent made no change, or the
            // user typed exactly it): adopt cleanly, token included.
            setDoc(fresh)
            baseShaRef.current = fresh.content_sha256 ?? null
            setDirty(false)
            setConflict(false)
          } else {
            // The user typed during the agent's turn. Do NOT clobber the
            // buffer and do NOT adopt the fresh token — the stale token makes
            // the next autosave 409 loudly instead of silently overwriting
            // the agent's edit.
            setConflict(true)
          }
        } else {
          setDoc(fresh)
          setBuffer(fresh.content ?? '')
          baseShaRef.current = fresh.content_sha256 ?? null
        }
        // The turn may have replied to / advanced threads: refresh them.
        void fetchThreads(doc.slug)
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
  const [commentNote, setCommentNote] = useState('')
  const [commentSending, setCommentSending] = useState(false)

  const sendComment = useCallback(async () => {
    if (!doc || !commentQuote || !commentNote.trim() || commentSending) return
    setCommentSending(true)
    try {
      await api.postArtifactComment(doc.slug, {
        text: commentNote.trim(),
        anchor: { quote: commentQuote },
      })
      const key = slotKey ?? await startSession()
      if (key) {
        const msg =
          'A new comment was anchored on the document we are co-authoring. '
          + 'Read the open comment threads with artifact_get_comments and '
          + 'address them: act on each, reply on the thread, and advance it '
          + 'with artifact_mark_review.'
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 10_000)
        try {
          const r = await api.sendChat(msg, key, undefined, controller.signal)
          if (!r.ok) throw new Error(`Send failed (${r.status})`)
        } finally {
          clearTimeout(timeout)
        }
      }
      setCommentQuote(null)
      setCommentNote('')
      setChatOpen(true)
      void fetchThreads(doc.slug)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCommentSending(false)
    }
  }, [doc, commentQuote, commentNote, commentSending, slotKey, startSession, fetchThreads])

  const resolveThread = useCallback(async (id: string) => {
    if (!doc) return
    try {
      await api.resolveComment(doc.slug, id)
      void fetchThreads(doc.slug)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [doc, fetchThreads])

  // Root, unresolved threads drive both the strip and (via the editor) the
  // decorations. Orphan verdict = server flag OR local resolution miss.
  const rootThreads = useMemo(
    () => threads.filter(t => !t.parent_id && t.status !== 'resolved'),
    [threads],
  )
  const isOrphaned = useCallback(
    (t: CommentThread) => !!t.anchor_orphaned || orphanedLocal.includes(t.id),
    [orphanedLocal],
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
    <div className="flex h-full min-h-0 overflow-hidden" data-testid="scribe-page">
      {/* Document list */}
      <aside className="w-52 shrink-0 border-r border-border bg-card flex flex-col min-h-0">
        <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border shrink-0">
          <PenLine className="lucide-inline text-accent" />
          <span className="flex-1 text-[13px] font-semibold text-text">Scribe</span>
          <button
            type="button"
            onClick={createDoc}
            title="New document"
            aria-label="New document"
            className="p-1 rounded text-muted hover:text-text hover:bg-bg-hover cursor-pointer bg-transparent border-none transition-colors"
          >
            <FilePlus2 className="lucide-inline" />
          </button>
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
        <div className="flex-1 min-h-0">
          {doc ? (
            <RichMarkdownEditor
              ref={editorRef}
              value={buffer}
              onChange={onEdit}
              onComment={quote => {
                setCommentQuote(quote)
                setCommentNote('')
              }}
              commentThreads={rootThreads}
              onThreadsResolved={setOrphanedLocal}
              onThreadClick={setFocusThread}
            />
          ) : (
            <div className="h-full flex items-center justify-center text-[13px] text-muted">
              Open a document to start writing.
            </div>
          )}
        </div>
        {rootThreads.length > 0 && (
          <div className="border-t border-border shrink-0 max-h-36 overflow-y-auto" data-testid="scribe-threads">
            {rootThreads.map(t => (
              <div
                key={t.id}
                className={`flex items-center gap-2 px-3 py-1.5 text-[12px] border-b border-border/50 last:border-b-0 ${
                  focusThread === t.id ? 'bg-bg-hover' : ''
                }`}
              >
                <span
                  className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                    t.status === 'review' ? 'bg-success/15 text-success' : 'bg-accent/15 text-accent'
                  }`}
                >
                  {t.status}
                </span>
                {isOrphaned(t) && (
                  <span
                    className="shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide bg-warn/15 text-warn"
                    title="The anchored passage no longer exists in the document"
                  >
                    orphaned
                  </span>
                )}
                <span className="flex-1 truncate text-text" title={t.body}>
                  {t.is_agent ? '🤖 ' : ''}{t.body}
                </span>
                {suggestionFor.has(t.id) ? (
                  <>
                    <button
                      type="button"
                      onClick={() => void acceptSuggestion(t)}
                      title="Apply the proposed replacement at the anchored passage and resolve the thread"
                      className="shrink-0 rounded-md border border-success/40 bg-success/10 px-2 py-0.5 text-[11px] text-success hover:bg-success/20 cursor-pointer transition-colors"
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      onClick={() => void rejectSuggestion(t)}
                      title="Decline the proposal and resolve the thread"
                      className="shrink-0 rounded-md border border-border bg-bg-elevated px-2 py-0.5 text-[11px] text-muted hover:text-text hover:bg-bg-hover cursor-pointer transition-colors"
                    >
                      Reject
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => void resolveThread(t.id)}
                    title="Resolve this thread (human-only — the co-author can only mark it for review)"
                    className="shrink-0 rounded-md border border-border bg-bg-elevated px-2 py-0.5 text-[11px] text-text hover:bg-bg-hover cursor-pointer transition-colors"
                  >
                    Resolve
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {commentQuote && (
          <div className="border-t border-border px-3 py-2 shrink-0 flex flex-col gap-1.5" data-testid="scribe-comment-composer">
            <div className="text-[12px] text-muted truncate">
              “{commentQuote.length > 140 ? `${commentQuote.slice(0, 140)}…` : commentQuote}”
            </div>
            <div className="flex items-center gap-2">
              <input
                value={commentNote}
                onChange={e => setCommentNote(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') void sendComment()
                  if (e.key === 'Escape') setCommentQuote(null)
                }}
                 
                // opens from an explicit pill click; focus continues that gesture.
                autoFocus
                aria-label="Comment for the co-author"
                placeholder="What should the co-author do with this passage?"
                className="flex-1 min-w-0 rounded-md border border-border bg-bg-elevated px-2 py-1 text-[13px] text-text outline-none focus-ring"
              />
              <button
                type="button"
                onClick={() => void sendComment()}
                disabled={!commentNote.trim() || commentSending}
                className="rounded-md border border-border bg-bg-elevated px-2 py-1 text-[12px] text-text hover:bg-bg-hover cursor-pointer disabled:opacity-50 disabled:cursor-default transition-colors"
              >
                {commentSending ? 'Sending…' : 'Comment & notify'}
              </button>
              <button
                type="button"
                onClick={() => setCommentQuote(null)}
                className="rounded-md px-2 py-1 text-[12px] text-muted hover:text-text cursor-pointer bg-transparent border-none transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </main>

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
