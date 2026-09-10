/**
 * Comment-highlight decorations for the Inkwell editor.
 *
 * A ProseMirror plugin holding a DecorationSet:
 *  - REBUILT when the host pushes a new resolved-highlight list via
 *    `setMeta(commentHighlightsKey, highlights)` (after a comments fetch or a
 *    re-resolution);
 *  - MAPPED through ordinary transactions between pushes, so decorations
 *    track live typing for free (the RFC's "live tracking is native PM
 *    machinery" claim, in code).
 *
 * Clicks on a decorated range surface the thread id to the host through the
 * extension option — navigation stays the page's business.
 *
 * Own pluginKey: ProseMirror plugins collide without distinct keys.
 */
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { ThreadHighlight } from './anchors'

export const commentHighlightsKey = new PluginKey<DecorationSet>('scribeCommentHighlights')

export interface CommentHighlightsOptions {
  onThreadClick?: (threadId: string) => void
}

function buildDecorations(highlights: ThreadHighlight[], docSize: number): Decoration[] {
  return highlights
    .filter(h => h.from >= 0 && h.to > h.from && h.to <= docSize)
    .map(h =>
      Decoration.inline(
        h.from,
        h.to,
        {
          class: `inkwell-comment-hl inkwell-comment-hl--${h.status}`,
          'data-thread-id': h.id,
        },
        // spec: readable back off DecorationSet.find() results — attrs are
        // not — so the gutter markers and caret detection can identify the
        // thread at a LIVE (mapped) position without a DOM round-trip.
        { threadId: h.id, status: h.status },
      ),
    )
}

/** Live (transaction-mapped) thread ranges currently decorated. */
export function liveThreadRanges(state: EditorState): Array<{ id: string; status: string; from: number; to: number }> {
  const set = commentHighlightsKey.getState(state)
  if (!set) return []
  return set.find().map(d => ({
    id: String((d.spec as { threadId?: string }).threadId ?? ''),
    status: String((d.spec as { status?: string }).status ?? 'open'),
    from: d.from,
    to: d.to,
  })).filter(r => r.id)
}

/** Thread id whose live range contains `pos`, or null. */
export function threadAtPos(state: EditorState, pos: number): string | null {
  const set = commentHighlightsKey.getState(state)
  const hit = set?.find(pos, pos)[0]
  return hit ? String((hit.spec as { threadId?: string }).threadId ?? '') || null : null
}

export const CommentHighlights = Extension.create<CommentHighlightsOptions>({
  name: 'scribeCommentHighlights',

  addOptions() {
    return { onThreadClick: undefined }
  },

  addProseMirrorPlugins() {
    const opts = this.options
    return [
      new Plugin<DecorationSet>({
        key: commentHighlightsKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const pushed = tr.getMeta(commentHighlightsKey) as ThreadHighlight[] | undefined
            if (pushed) {
              return DecorationSet.create(tr.doc, buildDecorations(pushed, tr.doc.content.size))
            }
            return tr.docChanged ? old.map(tr.mapping, tr.doc) : old
          },
        },
        props: {
          decorations(state) {
            return commentHighlightsKey.getState(state)
          },
          handleClick(view, pos) {
            if (!opts.onThreadClick) return false
            const id = threadAtPos(view.state, pos)
            if (!id) return false
            opts.onThreadClick(id)
            // Do NOT swallow the click: the caret should still land where the
            // user clicked so the popover tracks a real position.
            return false
          },
        },
      }),
    ]
  },
})
