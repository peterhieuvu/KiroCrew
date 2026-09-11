/**
 * Proposed edits: suggestion fences in comment threads (RFC phase 3).
 *
 * A proposal is a comment on an anchored thread whose body carries a
 * GitHub-style suggestion fence:
 *
 *     Tightened per your ask:
 *     ```suggestion
 *     the replacement text
 *     ```
 *
 * Chosen over a schema change because it needs nothing anywhere: the comment
 * store is untouched, any chat surface renders it legibly, and the co-author
 * writes it with the reply tool it already has. The *pending-proposal store*
 * is the thread itself — accept/reject land on the human-only resolve path,
 * so the permission model already enforces who decides.
 *
 * Applying uses the same anchor resolution as highlights: the range is
 * re-resolved at CLICK time (never cached), so a proposal accepted after
 * further editing lands where the quote lives NOW, or refuses if the anchor
 * has orphaned. The applied edit is dispatched as an ordinary editor
 * transaction, so it flows through onUpdate → autosave like a keystroke.
 */
import type { Editor } from '@tiptap/core'
import { resolveAnchor, type CommentAnchor } from './anchors'

const FENCE_RE = /```suggestion[ \t]*\n([\s\S]*?)```/

/** Extract the replacement text from the first suggestion fence in a comment
 *  body, or null when the body carries none. Trailing newline inside the
 *  fence is fence syntax, not content. */
export function parseSuggestion(body: string): string | null {
  const m = FENCE_RE.exec(body ?? '')
  if (!m) return null
  return m[1].replace(/\n$/, '')
}

/** Apply a suggestion at its anchor. Returns false when the anchor no longer
 *  resolves (orphaned) — the caller surfaces that instead of guessing.
 *
 *  Insertion mode: a single-line replacement is inserted as plain text (an
 *  inline splice must not split the host block); a multi-line replacement is
 *  parsed as markdown (it is block-shaped by construction). */
export function applySuggestion(
  editor: Editor,
  anchor: CommentAnchor,
  replacement: string,
): boolean {
  const range = resolveAnchor(editor.state.doc, anchor)
  if (!range) return false
  if (replacement.includes('\n')) {
    editor.chain()
      .insertContentAt(range, replacement, { contentType: 'markdown' })
      .run()
  } else {
    editor.chain().insertContentAt(range, replacement).run()
  }
  return true
}
