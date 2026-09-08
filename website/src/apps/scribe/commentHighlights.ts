/**
 * Comment-highlight decorations for the Scribe editor.
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
import { Plugin, PluginKey } from '@tiptap/pm/state'
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
      Decoration.inline(h.from, h.to, {
        class: `scribe-comment-hl scribe-comment-hl--${h.status}`,
        'data-thread-id': h.id,
      }),
    )
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
            const set = commentHighlightsKey.getState(view.state)
            if (!set) return false
            const hit = set.find(pos, pos)[0] as (Decoration & { spec?: unknown }) | undefined
            // Decoration attrs are not exposed on find() results; read the
            // thread id off the DOM element under the click instead.
            const dom = view.domAtPos(pos).node
            const el = (dom.nodeType === 1 ? (dom as Element) : dom.parentElement)
              ?.closest?.('[data-thread-id]')
            const id = el?.getAttribute('data-thread-id')
            if (hit && id) {
              opts.onThreadClick(id)
              return true
            }
            return false
          },
        },
      }),
    ]
  },
})
