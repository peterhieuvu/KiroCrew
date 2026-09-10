/**
 * ThreadPopover — a comment thread shown AT THE PASSAGE (Quip/Chorus-style),
 * not in a strip the eye skips. Anchored beside the highlighted range via the
 * editor's `threadAnchorRect`; shows the root comment, every reply (agent
 * replies attributed, suggestion fences rendered as a preview block), status
 * and orphan badges, and the human actions: Accept / Reject on a proposal,
 * Resolve otherwise, Reply to continue the thread.
 */
import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { CommentThread } from './anchors'
import { parseSuggestion } from './suggestions'

interface Props {
  root: CommentThread
  replies: CommentThread[]
  /** Latest suggestion text on the thread, if it is a proposal. */
  suggestion: string | undefined
  orphaned: boolean
  /** Wrapper-relative anchor; the popover opens to the right/below it. */
  anchor: { x: number; y: number } | null
  onAccept: () => void
  onReject: () => void
  onResolve: () => void
  onReply: (text: string) => Promise<void>
  onClose: () => void
}

/** Strip the suggestion fence out of a body so the prose reads cleanly; the
 *  fence itself is rendered as its own preview block. */
function bodyWithoutFence(body: string): string {
  return body.replace(/```suggestion[ \t]*\n[\s\S]*?```/, '').trim()
}

export default function ThreadPopover({
  root, replies, suggestion, orphaned, anchor, onAccept, onReject, onResolve, onReply, onClose,
}: Props) {
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  // Escape closes; click-outside closes (the editor's own click opens a new one).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('keydown', onKey)
    // Deferred so the opening click does not immediately close it.
    const t = setTimeout(() => window.addEventListener('mousedown', onDown), 0)
    return () => {
      window.removeEventListener('keydown', onKey)
      clearTimeout(t)
      window.removeEventListener('mousedown', onDown)
    }
  }, [onClose])

  const send = async () => {
    if (!reply.trim() || sending) return
    setSending(true)
    try { await onReply(reply.trim()); setReply('') } finally { setSending(false) }
  }

  // Orphaned threads have no live range: dock them top-right instead.
  const style = anchor
    ? { left: Math.min(anchor.x + 8, 9999), top: anchor.y + 6 }
    : { right: 12, top: 12 }

  const chain = [root, ...replies]

  return (
    <div
      ref={boxRef}
      role="dialog"
      aria-label="Comment thread"
      data-testid="inkwell-thread-popover"
      className="absolute z-20 w-[340px] max-h-[60%] flex flex-col rounded-lg border border-border bg-bg-elevated shadow-lg text-[12px]"
      style={style}
    >
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border shrink-0">
        <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
          root.status === 'review' ? 'bg-success/15 text-success' : 'bg-accent/15 text-accent'
        }`}>{root.status}</span>
        {orphaned && (
          <span className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide bg-warn/15 text-warn" title="The anchored passage no longer exists in the document">orphaned</span>
        )}
        {root.anchor?.quote && (
          <span className="flex-1 truncate text-muted italic" title={root.anchor.quote}>“{root.anchor.quote}”</span>
        )}
        <button type="button" onClick={onClose} aria-label="Close thread" className="p-0.5 rounded text-muted hover:text-text hover:bg-bg-hover cursor-pointer bg-transparent border-none"><X size={13} /></button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-2 flex flex-col gap-2">
        {chain.map(c => {
          const fence = parseSuggestion(c.body)
          return (
            <div key={c.id} className="flex flex-col gap-0.5">
              <div className="text-[10px] text-muted">{c.is_agent ? '🤖 co-author' : 'you'}</div>
              <div className="text-text whitespace-pre-wrap">{fence !== null ? bodyWithoutFence(c.body) : c.body}</div>
              {fence !== null && (
                <pre
                  data-testid="inkwell-suggestion-preview"
                  className="mt-1 rounded border border-success/40 bg-success/10 px-2 py-1 text-[11px] text-text whitespace-pre-wrap font-sans"
                  title="Proposed replacement for the quoted passage"
                >{fence === '' ? '(delete the passage)' : fence}</pre>
              )}
            </div>
          )
        })}
      </div>

      <div className="border-t border-border px-3 py-2 shrink-0 flex flex-col gap-1.5">
        <div className="flex items-center gap-1.5">
          <input
            value={reply}
            onChange={e => setReply(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void send() }}
            aria-label="Reply to thread"
            placeholder="Reply…"
            className="flex-1 min-w-0 rounded-md border border-border bg-bg px-2 py-1 text-[12px] text-text outline-none focus-ring"
          />
          <button type="button" onClick={() => void send()} disabled={!reply.trim() || sending} className="rounded-md border border-border bg-bg-elevated px-2 py-1 text-[11px] text-text hover:bg-bg-hover cursor-pointer disabled:opacity-50 disabled:cursor-default">Reply</button>
        </div>
        <div className="flex items-center gap-1.5 justify-end">
          {suggestion !== undefined ? (
            <>
              <button type="button" onClick={onAccept} disabled={orphaned} title={orphaned ? 'Cannot apply: the passage no longer exists' : 'Apply the proposed replacement and resolve'} className="rounded-md border border-success/40 bg-success/10 px-2 py-1 text-[11px] text-success hover:bg-success/20 cursor-pointer disabled:opacity-50 disabled:cursor-default">Accept</button>
              <button type="button" onClick={onReject} title="Decline the proposal and resolve" className="rounded-md border border-border bg-bg-elevated px-2 py-1 text-[11px] text-muted hover:text-text hover:bg-bg-hover cursor-pointer">Reject</button>
            </>
          ) : (
            <button type="button" onClick={onResolve} title="Resolve this thread (human-only — the co-author can only mark it for review)" className="rounded-md border border-border bg-bg-elevated px-2 py-1 text-[11px] text-text hover:bg-bg-hover cursor-pointer">Resolve</button>
          )}
        </div>
      </div>
    </div>
  )
}
