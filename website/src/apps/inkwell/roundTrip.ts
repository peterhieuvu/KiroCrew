/**
 * Round-trip loss detection.
 *
 * A markdown document is only safe to autosave from the WYSIWYG editor if
 * parsing it and serializing it back preserves its content. Formatting drift
 * (`*` vs `-` bullets, `*em*` vs `_em_`) is expected and harmless — the design
 * doc calls it normalize-on-first-save. CONTENT drift is not: the sweep found
 * whole tables vanishing on the first keystroke. This module tells the two
 * apart so the page can refuse to autosave until the user has been told.
 *
 * Method: parse `source` with the editor's own extension set, serialize, then
 * compare the WORD multiset (not the bytes) of source vs round-trip. Markdown
 * syntax characters are stripped before comparison so `**bold**` ≡ `bold`,
 * `| a | b |` ≡ `a b`, `- [x] done` ≡ `done`. Anything left over in the source
 * that is missing from the round-trip is content the editor cannot represent.
 *
 * HTML comments are reported explicitly (they carry no words but are the one
 * construct we know is dropped wholesale), so an author's `<!-- TODO -->` is
 * surfaced even though it is invisible to the word check.
 */
import { Editor } from '@tiptap/core'
import { contentExtensions } from './extensions'

export interface RoundTripLoss {
  /** Words present in the source but absent after a round-trip. */
  missingWords: string[]
  /** HTML comments in the source (always dropped by the editor). */
  htmlComments: number
  /** True when anything above is non-empty. */
  lossy: boolean
}

/** Strip markdown syntax to a bag of words for content-only comparison. */
export function contentWords(markdown: string): Map<string, number> {
  const stripped = markdown
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[^\n]*\n?/g, ' ') // fence lines; the code body stays
    .replace(/^[ \t]*[-*+]\s+\[[ xX]\]\s+/gm, ' ') // task markers
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])\s+/gm, ' ') // list bullets
    .replace(/^[ \t]*#{1,6}\s+/gm, ' ') // heading hashes
    .replace(/^[ \t]*>\s?/gm, ' ') // blockquote
    .replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, ' ') // table rules
    .replace(/[|*_`~#\\]/g, ' ') // inline syntax + pipes
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, ' $1 ') // links/images → text
  const words = new Map<string, number>()
  for (const w of stripped.split(/\s+/)) {
    if (!w) continue
    words.set(w, (words.get(w) ?? 0) + 1)
  }
  return words
}

/** Parse `source` with the editor's schema and serialize it back. */
export function roundTrip(source: string): string {
  const editor = new Editor({
    extensions: contentExtensions(),
    content: source,
    contentType: 'markdown',
  })
  try {
    return editor.getMarkdown()
  } finally {
    editor.destroy()
  }
}

/** Report what a WYSIWYG round-trip of `source` would lose. */
export function roundTripLoss(source: string): RoundTripLoss {
  const htmlComments = (source.match(/<!--[\s\S]*?-->/g) ?? []).length
  const before = contentWords(source)
  const after = contentWords(roundTrip(source))
  const missingWords: string[] = []
  for (const [w, n] of before) {
    const have = after.get(w) ?? 0
    if (have < n) missingWords.push(w)
  }
  return { missingWords, htmlComments, lossy: missingWords.length > 0 || htmlComments > 0 }
}
