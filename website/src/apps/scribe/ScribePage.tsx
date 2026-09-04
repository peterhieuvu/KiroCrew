/**
 * ScribePage — markdown documents with an embedded agent co-author (prototype).
 *
 * Three-pane layout: document list | rich markdown editor | co-author chat.
 * The prototype exists to prove the papyrus co-author spine on a markdown
 * surface:
 *
 *   1. `startSession()` mints a STOCK chat slot (no agent/model/memory_mode
 *      override — the default context is the point) and injects an ephemeral
 *      scoping note naming the document's absolute path.
 *   2. CoAuthorPanel mounts the real embedded ChatPage on that slot.
 *   3. On the co-author's busy→idle transition the page re-reads the document
 *      WITHOUT flushing the editor buffer — the agent just wrote the file, so
 *      the browser buffer is the stale copy (papyrus's no-flush rule).
 *
 * Deliberately absent from v0 (design doc: prototype scope): Pierre editor,
 * git, wikilinks, the memory/knowledge context rail, working_dir picker.
 *
 * PROTOTYPE NOTE: user-facing strings are plain English pending i18n catalog
 * entries — a PR blocker, not a prototype blocker.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { FilePlus2, MessageSquareText, PenLine, Save } from 'lucide-react'
import { useAppDispatch, useAppSelector } from '../../store'
import { addSlotOptimistic, fetchSlots } from '../../store/dashboardSlice'
import { selectComposerBusy } from '../../store/chatSlice'
import type { ChatSlot } from '../../types'
import { api } from '../../api/client'
import RichMarkdownEditor from './RichMarkdownEditor'
import CoAuthorPanel from './CoAuthorPanel'
import { companionContextLines } from './companionPrompt'
import { loadSlot, saveSlot, scribeApi, StaleDocError, type DocDetail, type DocSummary } from './api'

export default function ScribePage() {
  const dispatch = useAppDispatch()

  const [docs, setDocs] = useState<DocSummary[]>([])
  const [doc, setDoc] = useState<DocDetail | null>(null)
  const [buffer, setBuffer] = useState('')
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [chatOpen, setChatOpen] = useState(true)
  const [slotKey, setSlotKey] = useState<string | null>(null)
  const [slotCreating, setSlotCreating] = useState(false)

  const refreshDocs = useCallback(async () => {
    try {
      setDocs((await scribeApi.listDocs()).docs)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    void refreshDocs()
  }, [refreshDocs])

  const openDoc = useCallback(async (name: string) => {
    try {
      const d = await scribeApi.readDoc(name)
      setDoc(d)
      setBuffer(d.content)
      setDirty(false)
      setConflict(false)
      setError(null)
      // Reattach the document's co-author session. The mapping is server-side
      // (survives browsers/profiles); verify the slot still EXISTS before
      // activating it — a remembered key whose session was deleted must fall
      // back to "Start a session", not switch the panel to a dead slot.
      setSlotKey(null)
      const remembered = await loadSlot(name)
      if (remembered) {
        try {
          const live = (await api.chatSlots()) as ChatSlot[]
          if (live.some(s => s.key === remembered)) setSlotKey(remembered)
        } catch {
          // Can't verify — optimistically reattach; switchSlot on a stale key
          // degrades to an empty session rather than an error.
          setSlotKey(remembered)
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const createDoc = useCallback(async () => {
    const name = window.prompt('Document name (letters, digits, dots, dashes):')
    if (!name) return
    try {
      await scribeApi.createDoc(name)
      await refreshDocs()
      await openDoc(name)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [refreshDocs, openDoc])

  const save = useCallback(async () => {
    if (!doc) return
    try {
      const res = await scribeApi.saveDoc(doc.name, buffer, doc.mtime)
      setDoc({ ...doc, content: buffer, mtime: res.mtime })
      setDirty(false)
      setConflict(false)
    } catch (e) {
      if (e instanceof StaleDocError) {
        // The file moved on disk (usually: the co-author wrote it while the
        // user also typed). Surface the conflict; reload adopts the disk copy.
        setConflict(true)
      } else {
        setError(e instanceof Error ? e.message : String(e))
      }
    }
  }, [doc, buffer])

  /** Re-read the open document from disk, dropping the buffer (explicit adopt). */
  const reloadFromDisk = useCallback(async () => {
    if (!doc) return
    await openDoc(doc.name)
  }, [doc, openDoc])

  // Cmd/Ctrl+S saves.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save])

  // --- co-author session lifecycle (papyrus's startSession, verbatim shape) --

  const startSession = useCallback(async (): Promise<string | null> => {
    if (!doc || slotCreating) return null
    setSlotCreating(true)
    try {
      // No `name`: the backend mints a unique slot key. No agent/model/
      // memory_mode overrides: the stock session's injected memory and
      // globally-mounted tools are the entire value proposition.
      const created = await api.createChatSlot(
        undefined, undefined, undefined, undefined, undefined,
        `Scribe: ${doc.name}`,
      )
      const key = created.key as string
      dispatch(addSlotOptimistic({
        key,
        title: created.title || doc.name,
        messages: 0,
        running: false,
      } as ChatSlot))
      api.chatSlotContext(key, companionContextLines(doc.name, doc.path).join('\n'), {
        source: 'scribe-co-author', ephemeral: true,
      }).catch(() => undefined)
      dispatch(fetchSlots())
      saveSlot(doc.name, key)
      setSlotKey(key)
      return key
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      setSlotCreating(false)
    }
  }, [doc, slotCreating, dispatch])

  // When the co-author finishes a turn, re-read the document: the agent edits
  // it on disk, so the pane the user is watching is stale until this runs.
  // Keyed on the busy→idle transition; `selectComposerBusy` is the store's
  // single answer to "is this session working" (papyrus's rationale, verbatim).
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
        const fresh = await scribeApi.readDoc(doc.name)
        if (dirtyRef.current) {
          if (fresh.content === buffer) {
            // The buffer already matches disk (user retyped the agent's text,
            // or the agent made no change): adopt cleanly.
            setDoc(fresh)
            setDirty(false)
            setConflict(false)
          } else {
            // The user typed during the agent's turn. Do NOT clobber their
            // buffer, and do NOT adopt the fresh mtime — keeping the stale
            // base token makes their next save 409 loudly instead of silently
            // overwriting the agent's edit.
            setConflict(true)
          }
        } else {
          setDoc(fresh)
          setBuffer(fresh.content)
        }
      } catch {
        // A refresh failure is not worth a banner: the user's next save
        // recovers, and surfacing it would blame them for the agent's turn.
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coAuthorBusy, slotKey, doc?.name])

  const toggleChat = useCallback(() => {
    setChatOpen(open => {
      if (!open && !slotKey) void startSession()
      return !open
    })
  }, [slotKey, startSession])

  // --- highlight → comment → co-author instruction ------------------------
  // spec_builder's review-comment mechanism, single-doc and send-per-comment:
  // the quote anchors by TEXT (the agent re-finds the passage with its file
  // tools), and delivery is an ordinary user turn into the co-author slot —
  // explicitly NOT slot-context injection, so the agent acts on it now.
  const [commentQuote, setCommentQuote] = useState<string | null>(null)
  const [commentNote, setCommentNote] = useState('')
  const [commentSending, setCommentSending] = useState(false)

  const sendComment = useCallback(async () => {
    if (!doc || !commentQuote || !commentNote.trim() || commentSending) return
    setCommentSending(true)
    try {
      const key = slotKey ?? await startSession()
      if (!key) return
      const msg =
        'Instruction on the document we are co-authoring — regarding this passage:\n'
        + `> ${commentQuote.replace(/\n/g, '\n> ')}\n\n`
        + commentNote.trim()
      // ChatPane's send shape: abort a hung POST instead of letting it look
      // sent for the browser's own network timeout.
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 10_000)
      try {
        const r = await api.sendChat(msg, key, undefined, controller.signal)
        if (!r.ok) throw new Error(`Send failed (${r.status})`)
      } finally {
        clearTimeout(timeout)
      }
      setCommentQuote(null)
      setCommentNote('')
      setChatOpen(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCommentSending(false)
    }
  }, [doc, commentQuote, commentNote, commentSending, slotKey, startSession])

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
              key={d.name}
              type="button"
              onClick={() => void openDoc(d.name)}
              className={`w-full text-left px-3 py-1.5 text-[13px] truncate cursor-pointer bg-transparent border-none transition-colors ${
                doc?.name === d.name ? 'text-accent bg-bg-hover' : 'text-text hover:bg-bg-hover'
              }`}
            >
              {d.name}
            </button>
          ))}
        </div>
      </aside>

      {/* Editor + preview */}
      <main className="flex-1 min-w-0 flex flex-col min-h-0">
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border shrink-0">
          <span className="flex-1 truncate text-[13px] text-text">
            {doc ? doc.name : 'Select or create a document'}
            {dirty ? ' •' : ''}
          </span>
          {conflict && (
            <span className="text-[12px] text-danger flex items-center gap-2">
              Changed on disk.
              <button
                type="button"
                onClick={() => void reloadFromDisk()}
                className="underline cursor-pointer bg-transparent border-none text-danger"
              >
                Reload
              </button>
            </span>
          )}
          <button
            type="button"
            onClick={() => void save()}
            disabled={!doc || !dirty}
            title="Save (Cmd/Ctrl+S)"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-elevated px-2 py-1 text-[12px] text-text hover:bg-bg-hover cursor-pointer disabled:opacity-50 disabled:cursor-default transition-colors"
          >
            <Save className="lucide-inline" /> Save
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
              value={buffer}
              onChange={md => {
                setBuffer(md)
                setDirty(true)
              }}
              onComment={quote => {
                setCommentQuote(quote)
                setCommentNote('')
              }}
            />
          ) : (
            <div className="h-full flex items-center justify-center text-[13px] text-muted">
              Open a document to start writing.
            </div>
          )}
        </div>
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
                // eslint-disable-next-line jsx-a11y/no-autofocus -- the composer only
                // opens from an explicit pill click; focus continues that gesture.
                autoFocus
                placeholder="What should the co-author do with this passage?"
                className="flex-1 min-w-0 rounded-md border border-border bg-bg-elevated px-2 py-1 text-[13px] text-text outline-none focus-ring"
              />
              <button
                type="button"
                onClick={() => void sendComment()}
                disabled={!commentNote.trim() || commentSending}
                className="rounded-md border border-border bg-bg-elevated px-2 py-1 text-[12px] text-text hover:bg-bg-hover cursor-pointer disabled:opacity-50 disabled:cursor-default transition-colors"
              >
                {commentSending ? 'Sending…' : 'Send to co-author'}
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
