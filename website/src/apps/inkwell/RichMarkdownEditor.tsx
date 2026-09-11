/**
 * RichMarkdownEditor — Tiptap-backed WYSIWYG markdown surface for Inkwell.
 *
 * Contract with InkwellPage: `value` is the document's markdown; `onChange`
 * receives serialized markdown on every user edit. External changes (open a
 * different doc, adopt the co-author's write on busy→idle, explicit reload)
 * arrive as a `value` the editor did not emit, and are applied with
 * `setContent(…, { emitUpdate: false })` so they never mark the buffer dirty
 * or clobber the papyrus-derived conflict handling upstream.
 *
 * The distinction between "external value" and "our own echo" is the
 * `lastEmittedRef` check — the same shape PapyrusEditor uses for its seed
 * logic. Without it, InkwellPage echoing `buffer` back down would reset the
 * caret on every keystroke.
 *
 * Round-trip note: markdown → ProseMirror → markdown normalizes formatting
 * (e.g. bullet markers, emphasis delimiters). The buffer therefore may differ
 * textually from disk after the first edit even where it is semantically
 * identical; the save path treats that as an ordinary edit, which is correct.
 *
 * PROTOTYPE NOTE: user-facing strings are plain English pending i18n catalog
 * entries — a PR blocker, not a prototype blocker (same status as InkwellPage).
 */
import { useEffect, useImperativeHandle, useReducer, useRef, useState, forwardRef } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import { contentExtensions } from './extensions'
import {
  Bold, Code, Heading1, Heading2, Heading3, Italic, Link2, List, ListOrdered,
  MessageSquarePlus, Minus, Redo2, SquareCode, Strikethrough, TextQuote, Undo2,
} from 'lucide-react'
import { IconButton } from '../../components/ui'
import { anchorForSelection, resolveThreads, snapToWordBounds, type CommentThread, type CommentAnchor } from './anchors'
import { CommentHighlights, commentHighlightsKey, liveThreadRanges, threadAtPos } from './commentHighlights'
import { applySuggestion } from './suggestions'
import './richEditor.css'

interface Props {
  /** Markdown source of the document. */
  value: string
  /** Fires with serialized markdown on every user edit. */
  onChange: (markdown: string) => void
  /**
   * When provided, selecting text raises a floating "Comment" pill; clicking
   * it hands the selected text (whitespace-collapsed, capped) to the host so
   * it can attach an instruction and route it to the co-author.
   */
  onComment?: (anchor: CommentAnchor, at: { x: number; y: number }) => void
  /** Root comment threads to resolve and decorate. Replies and resolved
   *  threads are skipped by the resolver. */
  commentThreads?: CommentThread[]
  /** Fires after each (re)resolution with ids that could NOT be located —
   *  the local counterpart of the server's `anchor_orphaned` verdict. */
  onThreadsResolved?: (orphanedIds: string[]) => void
  /** A decorated range was clicked. */
  onThreadClick?: (threadId: string) => void
  /** Caret context for the context rail AND thread popover: the caret's
   *  top-level block index, the current selection text (or null), and the
   *  id of the comment thread whose live range contains the caret (or null
   *  — the popover closes when the caret leaves a highlight). */
  onCaretContext?: (ctx: { blockIndex: number; selection: string | null; threadId: string | null }) => void
  disabled?: boolean
}

/** Imperative surface for the host page. */
export interface RichMarkdownEditorHandle {
  /** Re-resolve `anchor` NOW and splice `replacement` in as a normal edit
   *  (flows through onChange → autosave). False = anchor orphaned. */
  applySuggestion: (anchor: CommentAnchor, replacement: string) => boolean
  /** Return keyboard focus to the editor (popover dismissed by keyboard). */
  focus: () => void
  /** Wrapper-relative coordinates of a thread's LIVE decorated range (end of
   *  the range, for a popover beside the passage), or null when the thread
   *  is not currently decorated (orphaned / resolved). */
  threadAnchorRect: (threadId: string) => { x: number; y: number; top: number } | null
}

/** Minimum selection length for the comment pill (mirrors spec_builder). */
const MIN_QUOTE_LEN = 3
/** Cap carried quotes so a select-all cannot flood the chat turn. */
const MAX_QUOTE_LEN = 500

const RichMarkdownEditor = forwardRef<RichMarkdownEditorHandle, Props>(function RichMarkdownEditor({
  value, onChange, onComment, commentThreads, onThreadsResolved, onThreadClick, onCaretContext, disabled,
}, ref) {
  // Keep the latest onChange without making it an editor dependency — the
  // editor instance must survive parent re-renders or the caret dies.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  // The markdown this editor last produced (or last had set). A `value` prop
  // equal to this is our own echo; anything else is an external change.
  const lastEmittedRef = useRef(value)

  // Latest thread-click handler without re-instantiating the editor.
  const onThreadClickRef = useRef(onThreadClick)
  onThreadClickRef.current = onThreadClick

  const editor = useEditor({
    extensions: [
      ...contentExtensions(),
      CommentHighlights.configure({
        onThreadClick: (id: string) => onThreadClickRef.current?.(id),
      }),
    ],
    content: value,
    contentType: 'markdown',
    editable: !disabled,
    onUpdate: ({ editor: e }) => {
      const md = e.getMarkdown()
      lastEmittedRef.current = md
      onChangeRef.current(md)
    },
  })

  // Toolbar active-state: `useEditorState` selectors do not re-run on
  // selection-only changes, so subscribe to transactions directly (every
  // selection move and content change dispatches one).
  const [, forceRender] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    if (!editor) return
    editor.on('transaction', forceRender)
    return () => { editor.off('transaction', forceRender) }
  }, [editor])

  // Caret context for the rail: block index of the caret's top-level node
  // plus the selection text. Only on selectionUpdate — content-only
  // transactions don't move the subject.
  const onCaretContextRef = useRef(onCaretContext)
  onCaretContextRef.current = onCaretContext
  useEffect(() => {
    if (!editor) return
    const handler = () => {
      const fn = onCaretContextRef.current
      if (!fn) return
      const { from, to } = editor.state.selection
      const $from = editor.state.doc.resolve(from)
      const blockIndex = $from.index(0)
      const selection = from === to ? null : editor.state.doc.textBetween(from, to, ' ')
      // Caret inside a highlight → that thread; the page opens its popover.
      const threadId = from === to ? threadAtPos(editor.state, from) : null
      fn({ blockIndex, selection, threadId })
    }
    editor.on('selectionUpdate', handler)
    return () => { editor.off('selectionUpdate', handler) }
  }, [editor])

  // Apply external value changes without emitting an update (no dirty flag,
  // no onChange echo loop).
  // Comment pill state (settled on mouseup/keyup; see settleSelection).
  const [commentSel, setCommentSel] = useState<{ anchor: CommentAnchor; x: number; y: number } | null>(null)
  useEffect(() => {
    if (!editor || value === lastEmittedRef.current) return
    lastEmittedRef.current = value
    editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false })
    setCommentSel(null) // the selection the pill described no longer exists
  }, [editor, value])

  // Stale-pill guard (sweep finding, 2026-09-10): the pill settles on
  // mouseup/keyup, but a selection can collapse without either (a programmatic
  // setContent, a click that lands on the pill itself, focus moving to a
  // popover). Any collapsed selection retires the pill.
  useEffect(() => {
    if (!editor) return
    const onSel = () => { if (editor.state.selection.empty) setCommentSel(null) }
    editor.on('selectionUpdate', onSel)
    return () => { editor.off('selectionUpdate', onSel) }
  }, [editor])

  useEffect(() => {
    // emitUpdate=false: setEditable fires the 'update' event by default, which
    // would route through onUpdate → onChange and mark a just-opened document
    // dirty before the user typed anything.
    editor?.setEditable(!disabled, false)
  }, [editor, disabled])

  // Imperative accept path: resolve-at-click and splice. Kept on a handle
  // (not props) because it is a command, not state — the page fires it from
  // the thread strip's Accept button.
  const wrapRef = useRef<HTMLDivElement>(null)
  useImperativeHandle(ref, () => ({
    applySuggestion: (anchor: CommentAnchor, replacement: string) =>
      editor ? applySuggestion(editor, anchor, replacement) : false,
    focus: () => { editor?.commands.focus() },
    threadAnchorRect: (threadId: string) => {
      if (!editor || !wrapRef.current) return null
      const range = liveThreadRanges(editor.state).find(r => r.id === threadId)
      if (!range) return null
      const host = wrapRef.current.getBoundingClientRect()
      const end = editor.view.coordsAtPos(range.to)
      const start = editor.view.coordsAtPos(range.from)
      return { x: end.right - host.left, y: end.bottom - host.top, top: start.top - host.top }
    },
  }), [editor])

  // --- comment thread resolution → decorations -----------------------------
  // Re-resolve when the thread list changes OR external content lands (the
  // `value` dep covers the busy→idle reload adopting an agent edit). Between
  // resolutions, the plugin maps decorations through user typing natively.
  const onThreadsResolvedRef = useRef(onThreadsResolved)
  onThreadsResolvedRef.current = onThreadsResolved
  useEffect(() => {
    if (!editor) return
    const { highlights, orphanedIds } = resolveThreads(editor.state.doc, commentThreads ?? [])
    const tr = editor.state.tr.setMeta(commentHighlightsKey, highlights)
    editor.view.dispatch(tr)
    onThreadsResolvedRef.current?.(orphanedIds)
     
  }, [editor, commentThreads, value])

  // --- comment pill (spec_builder's selection→pill pattern, editor-native) --
  // Settled on mouseup/keyup rather than every transaction so the pill does
  // not flicker mid-drag. Position comes from the editor's own coordsAtPos —
  // relative to the outer wrapper, like DocView's rect math.
  const settleSelection = () => {
    if (!onComment || !editor) return
    // Snap outward to word boundaries: ragged free-hand anchors under-cover
    // the passage and leave remnants when a suggestion replaces the range
    // (live-verification finding, 2026-09-08).
    const sel = editor.state.selection
    const { from, to } = snapToWordBounds(editor.state.doc, sel.from, sel.to)
    const quote = editor.state.doc.textBetween(from, to, ' ').replace(/\s+/g, ' ').trim()
    if (quote.length < MIN_QUOTE_LEN) {
      setCommentSel(null)
      return
    }
    // Full anchor (prefix/suffix/offsets) so a repeated passage resolves to
    // THIS occurrence, not the first one in the document.
    const anchor = anchorForSelection(editor.state.doc, from, quote.slice(0, MAX_QUOTE_LEN))
    if (!anchor) {
      setCommentSel(null)
      return
    }
    const host = wrapRef.current?.getBoundingClientRect()
    if (!host) return
    const coords = editor.view.coordsAtPos(to)
    setCommentSel({
      anchor,
      x: Math.min(coords.left - host.left, host.width - 96),
      y: coords.bottom - host.top + 6,
    })
  }

  if (!editor) return null

  // Gutter marker positions, derived each render from live decorations.
  // Wrapper-relative; the wrapper is the positioned ancestor. Computed inline
  // (not memoized) because every transaction re-renders via forceRender and
  // coordsAtPos is cheap for a handful of threads.
  const gutterMarkers = (() => {
    const host = wrapRef.current?.getBoundingClientRect()
    if (!host) return [] as Array<{ id: string; status: string; top: number }>
    return liveThreadRanges(editor.state).map(r => ({
      id: r.id,
      status: r.status,
      top: editor.view.coordsAtPos(r.from).top - host.top,
    }))
  })()

  const setLink = () => {
    const prev = editor.getAttributes('link').href as string | undefined
    // Prototype idiom (matches InkwellPage's createDoc): prompt over popover.
    const url = window.prompt('Link URL (empty to remove):', prev || '')
    if (url === null) return
    const chain = editor.chain().focus().extendMarkRange('link')
    if (url === '') chain.unsetLink().run()
    else chain.setLink({ href: url }).run()
  }

  const btnCls = (active: boolean) => (active ? 'text-accent bg-bg-hover' : 'text-muted hover:text-text')

  return (
    <div ref={wrapRef} className="inkwell-rich relative flex h-full min-h-0 flex-col" data-testid="inkwell-editor">
      <div className="flex items-center gap-0.5 border-b border-border px-2 py-1 shrink-0 flex-wrap" role="toolbar" aria-label="Formatting">
        <IconButton aria-label="Undo" title="Undo" disabled={disabled || !editor.can().undo()} onClick={() => editor.chain().focus().undo().run()} className="text-muted hover:text-text"><Undo2 size={15} /></IconButton>
        <IconButton aria-label="Redo" title="Redo" disabled={disabled || !editor.can().redo()} onClick={() => editor.chain().focus().redo().run()} className="text-muted hover:text-text"><Redo2 size={15} /></IconButton>
        <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
        <IconButton aria-label="Heading 1" title="Heading 1" disabled={disabled} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} className={btnCls(editor.isActive('heading', { level: 1 }))}><Heading1 size={15} /></IconButton>
        <IconButton aria-label="Heading 2" title="Heading 2" disabled={disabled} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} className={btnCls(editor.isActive('heading', { level: 2 }))}><Heading2 size={15} /></IconButton>
        <IconButton aria-label="Heading 3" title="Heading 3" disabled={disabled} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} className={btnCls(editor.isActive('heading', { level: 3 }))}><Heading3 size={15} /></IconButton>
        <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
        <IconButton aria-label="Bold" title="Bold (Cmd/Ctrl+B)" disabled={disabled} onClick={() => editor.chain().focus().toggleBold().run()} className={btnCls(editor.isActive('bold'))}><Bold size={15} /></IconButton>
        <IconButton aria-label="Italic" title="Italic (Cmd/Ctrl+I)" disabled={disabled} onClick={() => editor.chain().focus().toggleItalic().run()} className={btnCls(editor.isActive('italic'))}><Italic size={15} /></IconButton>
        <IconButton aria-label="Strikethrough" title="Strikethrough" disabled={disabled} onClick={() => editor.chain().focus().toggleStrike().run()} className={btnCls(editor.isActive('strike'))}><Strikethrough size={15} /></IconButton>
        <IconButton aria-label="Inline code" title="Inline code" disabled={disabled} onClick={() => editor.chain().focus().toggleCode().run()} className={btnCls(editor.isActive('code'))}><Code size={15} /></IconButton>
        <IconButton aria-label="Link" title="Link" disabled={disabled} onClick={setLink} className={btnCls(editor.isActive('link'))}><Link2 size={15} /></IconButton>
        <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
        <IconButton aria-label="Bullet list" title="Bullet list" disabled={disabled} onClick={() => editor.chain().focus().toggleBulletList().run()} className={btnCls(editor.isActive('bulletList'))}><List size={15} /></IconButton>
        <IconButton aria-label="Numbered list" title="Numbered list" disabled={disabled} onClick={() => editor.chain().focus().toggleOrderedList().run()} className={btnCls(editor.isActive('orderedList'))}><ListOrdered size={15} /></IconButton>
        <IconButton aria-label="Blockquote" title="Blockquote" disabled={disabled} onClick={() => editor.chain().focus().toggleBlockquote().run()} className={btnCls(editor.isActive('blockquote'))}><TextQuote size={15} /></IconButton>
        <IconButton aria-label="Code block" title="Code block" disabled={disabled} onClick={() => editor.chain().focus().toggleCodeBlock().run()} className={btnCls(editor.isActive('codeBlock'))}><SquareCode size={15} /></IconButton>
        <IconButton aria-label="Horizontal rule" title="Horizontal rule" disabled={disabled} onClick={() => editor.chain().focus().setHorizontalRule().run()} className="text-muted hover:text-text"><Minus size={15} /></IconButton>
      </div>
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions --
          Passive listeners only: the div relays clicks into the contenteditable
          (which owns focus and keyboard) and observes selection settle for the
          comment pill. It is not itself an interactive control. */}
      <div
        className="flex-1 min-h-0 overflow-y-auto"
        onClick={() => editor.chain().focus().run()}
        onMouseUp={settleSelection}
        onKeyUp={settleSelection}
        onScroll={() => setCommentSel(null)}
      >
        <EditorContent editor={editor} className="h-full" />
      </div>
      {/* Gutter markers: one per live thread range, at the range's first line.
          Read from the DecorationSet so they follow the text through edits.
          Rendered on every transaction (forceRender) so positions stay true. */}
      {onThreadClick && gutterMarkers.map(m => (
        <button
          key={m.id}
          type="button"
          data-testid="inkwell-gutter-marker"
          aria-label={`Open comment thread (${m.status})`}
          title="Open comment thread"
          onClick={() => onThreadClick(m.id)}
          className={`absolute right-1 h-3 w-3 rounded-full border cursor-pointer p-0 transition-colors ${
            m.status === 'resolved'
              ? 'bg-transparent border-border border-dashed hover:bg-bg-hover'
              : m.status === 'review'
                ? 'bg-success/30 border-success/60 hover:bg-success/60'
                : 'bg-accent/30 border-accent/60 hover:bg-accent/60'
          }`}
          style={{ top: m.top + 4 }}
        />
      ))}
      {commentSel && (
        <button
          type="button"
          data-testid="inkwell-comment-pill"
          className="absolute z-10 inline-flex items-center gap-1 rounded-md border border-border bg-bg-elevated px-2 py-1 text-[12px] text-text shadow-md hover:bg-bg-hover cursor-pointer transition-colors"
          style={{ left: commentSel.x, top: commentSel.y }}
          // onMouseDown, not onClick: a click would first blur the editor,
          // collapse the selection, and re-settle the pill away mid-press.
          onMouseDown={e => {
            e.preventDefault()
            const anchor = commentSel.anchor
            setCommentSel(null)
            onComment?.(anchor, { x: commentSel.x, y: commentSel.y })
          }}
        >
          <MessageSquarePlus size={13} /> Comment
        </button>
      )}
    </div>
  )
})

export default RichMarkdownEditor
