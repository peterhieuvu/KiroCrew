/**
 * RichMarkdownEditor — Tiptap-backed WYSIWYG markdown surface for Scribe.
 *
 * Contract with ScribePage: `value` is the document's markdown; `onChange`
 * receives serialized markdown on every user edit. External changes (open a
 * different doc, adopt the co-author's write on busy→idle, explicit reload)
 * arrive as a `value` the editor did not emit, and are applied with
 * `setContent(…, { emitUpdate: false })` so they never mark the buffer dirty
 * or clobber the papyrus-derived conflict handling upstream.
 *
 * The distinction between "external value" and "our own echo" is the
 * `lastEmittedRef` check — the same shape PapyrusEditor uses for its seed
 * logic. Without it, ScribePage echoing `buffer` back down would reset the
 * caret on every keystroke.
 *
 * Round-trip note: markdown → ProseMirror → markdown normalizes formatting
 * (e.g. bullet markers, emphasis delimiters). The buffer therefore may differ
 * textually from disk after the first edit even where it is semantically
 * identical; the save path treats that as an ordinary edit, which is correct.
 *
 * PROTOTYPE NOTE: user-facing strings are plain English pending i18n catalog
 * entries — a PR blocker, not a prototype blocker (same status as ScribePage).
 */
import { useEffect, useReducer, useRef, useState } from 'react'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import {
  Bold, Code, Heading1, Heading2, Heading3, Italic, Link2, List, ListOrdered,
  MessageSquarePlus, Minus, Redo2, SquareCode, Strikethrough, TextQuote, Undo2,
} from 'lucide-react'
import { IconButton } from '../../components/ui'
import { resolveThreads, type CommentThread } from './anchors'
import { CommentHighlights, commentHighlightsKey } from './commentHighlights'
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
  onComment?: (quote: string) => void
  /** Root comment threads to resolve and decorate. Replies and resolved
   *  threads are skipped by the resolver. */
  commentThreads?: CommentThread[]
  /** Fires after each (re)resolution with ids that could NOT be located —
   *  the local counterpart of the server's `anchor_orphaned` verdict. */
  onThreadsResolved?: (orphanedIds: string[]) => void
  /** A decorated range was clicked. */
  onThreadClick?: (threadId: string) => void
  disabled?: boolean
}

/** Minimum selection length for the comment pill (mirrors spec_builder). */
const MIN_QUOTE_LEN = 3
/** Cap carried quotes so a select-all cannot flood the chat turn. */
const MAX_QUOTE_LEN = 500

export default function RichMarkdownEditor({
  value, onChange, onComment, commentThreads, onThreadsResolved, onThreadClick, disabled,
}: Props) {
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
      // openOnClick off: a click in an editable surface places the caret; the
      // toolbar link button is the navigation affordance.
      StarterKit.configure({ link: { openOnClick: false } }),
      Markdown,
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

  // Apply external value changes without emitting an update (no dirty flag,
  // no onChange echo loop).
  useEffect(() => {
    if (!editor || value === lastEmittedRef.current) return
    lastEmittedRef.current = value
    editor.commands.setContent(value, { contentType: 'markdown', emitUpdate: false })
  }, [editor, value])

  useEffect(() => {
    // emitUpdate=false: setEditable fires the 'update' event by default, which
    // would route through onUpdate → onChange and mark a just-opened document
    // dirty before the user typed anything.
    editor?.setEditable(!disabled, false)
  }, [editor, disabled])

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
  const wrapRef = useRef<HTMLDivElement>(null)
  const [commentSel, setCommentSel] = useState<{ quote: string; x: number; y: number } | null>(null)
  const settleSelection = () => {
    if (!onComment || !editor) return
    const { from, to } = editor.state.selection
    const quote = editor.state.doc.textBetween(from, to, ' ').replace(/\s+/g, ' ').trim()
    if (quote.length < MIN_QUOTE_LEN) {
      setCommentSel(null)
      return
    }
    const host = wrapRef.current?.getBoundingClientRect()
    if (!host) return
    const coords = editor.view.coordsAtPos(to)
    setCommentSel({
      quote: quote.slice(0, MAX_QUOTE_LEN),
      x: Math.min(coords.left - host.left, host.width - 96),
      y: coords.bottom - host.top + 6,
    })
  }

  if (!editor) return null

  const setLink = () => {
    const prev = editor.getAttributes('link').href as string | undefined
    // Prototype idiom (matches ScribePage's createDoc): prompt over popover.
    const url = window.prompt('Link URL (empty to remove):', prev || '')
    if (url === null) return
    const chain = editor.chain().focus().extendMarkRange('link')
    if (url === '') chain.unsetLink().run()
    else chain.setLink({ href: url }).run()
  }

  const btnCls = (active: boolean) => (active ? 'text-accent bg-bg-hover' : 'text-muted hover:text-text')

  return (
    <div ref={wrapRef} className="scribe-rich relative flex h-full min-h-0 flex-col" data-testid="scribe-editor">
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
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events --
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
      {commentSel && (
        <button
          type="button"
          data-testid="scribe-comment-pill"
          className="absolute z-10 inline-flex items-center gap-1 rounded-md border border-border bg-bg-elevated px-2 py-1 text-[12px] text-text shadow-md hover:bg-bg-hover cursor-pointer transition-colors"
          style={{ left: commentSel.x, top: commentSel.y }}
          // onMouseDown, not onClick: a click would first blur the editor,
          // collapse the selection, and re-settle the pill away mid-press.
          onMouseDown={e => {
            e.preventDefault()
            const quote = commentSel.quote
            setCommentSel(null)
            onComment?.(quote)
          }}
        >
          <MessageSquarePlus size={13} /> Comment
        </button>
      )}
    </div>
  )
}
