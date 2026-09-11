/**
 * Heading context for the caret, read from the ProseMirror document itself.
 *
 * The context rail wants "the H1 and the nearest heading above the caret".
 * The first cut derived that from markdown text by counting non-empty line
 * runs to map the editor's top-level block index to a source line — which
 * desyncs on any block spanning several lines (a fenced code block, a
 * blockquote, a list), so the rail queried the wrong section (sweep finding,
 * 2026-09-10). The document already knows its blocks; ask it.
 */
import type { Node as PMNode } from '@tiptap/pm/model'

export interface CaretHeadings {
  /** The document's level-1 heading (or its first heading of any level). */
  h1: string | null
  /** The nearest heading at or above the caret's top-level block. */
  nearest: string | null
}

export function headingContext(doc: PMNode, blockIndex: number): CaretHeadings {
  let h1: string | null = null
  let firstAny: string | null = null
  let nearest: string | null = null
  doc.forEach((node, _offset, index) => {
    if (node.type.name !== 'heading') return
    const text = node.textContent.trim()
    if (!text) return
    if (firstAny === null) firstAny = text
    if (h1 === null && node.attrs.level === 1) h1 = text
    if (index <= blockIndex) nearest = text
  })
  return { h1: h1 ?? firstAny, nearest }
}
