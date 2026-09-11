/**
 * Inkwell anchor resolution + markdown round-trip idempotency.
 *
 * Both suites run against a REAL headless Tiptap editor with Inkwell's own
 * extension set, so the corpus below is simultaneously:
 *  - the anchor-resolution fixture (quotes located in real PM docs), and
 *  - the serializer-idempotency check the RFC's Risks section calls for:
 *    load → serialize must be a fixed point on the second pass, or offsets
 *    computed against the app's serialization don't hold.
 */
import { describe, it, expect } from 'vitest'
import { Editor } from '@tiptap/core'
import { contentExtensions } from '../apps/inkwell/extensions'
import { anchorForSelection, buildTextIndex, normalizeQuote, resolveAnchor, resolveThreads, snapToWordBounds } from '../apps/inkwell/anchors'

function makeEditor(markdown: string): Editor {
  return new Editor({
    extensions: contentExtensions(),
    content: markdown,
    contentType: 'markdown',
  })
}

/** load → serialize → load → serialize; the two serializations must agree. */
function roundTripStable(md: string): { first: string; second: string } {
  const e1 = makeEditor(md)
  const first = e1.getMarkdown()
  e1.destroy()
  const e2 = makeEditor(first)
  const second = e2.getMarkdown()
  e2.destroy()
  return { first, second }
}

// ── Corpus ──────────────────────────────────────────────────────────────────
// Shapes a design doc actually contains. Round-trip stability is asserted for
// every entry; anchor cases reuse a subset.
const CORPUS: Record<string, string> = {
  headings: '# Title\n\n## Section\n\nBody prose under the section.\n',
  emphasis: 'Some **bold** text, some *italic*, some `inline code`.\n',
  adjacentMarks: 'foo**bar**baz and **lead**tail\n',
  lists: '- one\n- two\n  - nested\n\n1. first\n2. second\n',
  taskList: '- [ ] open item\n- [x] done item\n',
  blockquote: '> quoted wisdom\n> second line\n',
  codeFence: '```ts\nconst x: number = 1\n```\n',
  links: 'See [the RFC](https://example.com/rfc) for details.\n',
  hr: 'above\n\n---\n\nbelow\n',
  mixed: '# Doc\n\nIntro with **bold** and a [link](https://example.com).\n\n- point one\n- point two\n\n> a quote\n\nFinal paragraph.\n',
}

describe('markdown round-trip idempotency (RFC risk gate)', () => {
  for (const [name, md] of Object.entries(CORPUS)) {
    it(`is a fixed point after first normalization: ${name}`, () => {
      const { first, second } = roundTripStable(md)
      // First pass may normalize (bullet glyphs, escapes) — that is the
      // documented normalize-on-first-save choice. The SECOND pass must be
      // byte-identical or offset anchoring against our serialization breaks.
      expect(second).toBe(first)
    })
  }
})

describe('buildTextIndex', () => {
  it('concatenates inline mark boundaries without separators', () => {
    const e = makeEditor(CORPUS.adjacentMarks)
    const { text } = buildTextIndex(e.state.doc)
    expect(text).toContain('foobarbaz')
    expect(text).toContain('leadtail')
    e.destroy()
  })

  it('separates blocks with a single space and collapses whitespace runs', () => {
    const e = makeEditor('# Title\n\nBody   with   runs.\n')
    const { text } = buildTextIndex(e.state.doc)
    expect(text).toBe('Title Body with runs.')
    e.destroy()
  })

  it('maps every searchable char to a valid PM position', () => {
    const e = makeEditor(CORPUS.mixed)
    const { text, positions } = buildTextIndex(e.state.doc)
    expect(positions.length).toBe(text.length)
    const max = e.state.doc.content.size
    for (const p of positions) {
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThanOrEqual(max)
    }
    e.destroy()
  })
})

describe('resolveAnchor', () => {
  it('resolves a unique quote to the exact PM range', () => {
    const e = makeEditor(CORPUS.mixed)
    const r = resolveAnchor(e.state.doc, { quote: 'point one' })
    expect(r).not.toBeNull()
    const covered = e.state.doc.textBetween(r!.from, r!.to, ' ')
    expect(normalizeQuote(covered)).toBe('point one')
    e.destroy()
  })

  it('resolves a quote spanning inline formatting', () => {
    const e = makeEditor(CORPUS.emphasis)
    const r = resolveAnchor(e.state.doc, { quote: 'some bold text' })
    // plain-text index sees "Some bold text..." — case matters; use exact
    const r2 = resolveAnchor(e.state.doc, { quote: 'Some bold text' })
    expect(r).toBeNull() // case-sensitive contract, same as the server rescan
    expect(r2).not.toBeNull()
    e.destroy()
  })

  it('survives an intervening edit elsewhere in the doc (quote re-resolution)', () => {
    const e = makeEditor('# T\n\nAlpha sentence here.\n\nBeta sentence here.\n')
    const before = resolveAnchor(e.state.doc, { quote: 'Beta sentence here.' })
    // Edit ABOVE the anchor: insert text into the first paragraph.
    e.commands.insertContentAt(5, 'PREFIX ')
    const after = resolveAnchor(e.state.doc, { quote: 'Beta sentence here.' })
    expect(before).not.toBeNull()
    expect(after).not.toBeNull()
    expect(after!.from).toBeGreaterThan(before!.from) // shifted, still found
    const covered = e.state.doc.textBetween(after!.from, after!.to, ' ')
    expect(normalizeQuote(covered)).toBe('Beta sentence here.')
    e.destroy()
  })

  it('REGRESSION: a comment on the LAST of four identical lines stays on the last line', () => {
    // Live finding 2026-09-10: quote-only anchors on repeated text floated
    // back to the first occurrence. The creation-side helper must record
    // enough context for the resolver to pick THIS occurrence.
    const e = makeEditor('# T\n\nHello\n\nasdf\n\nasdf\n\nasdf\n\nasdf\n')
    // Find the PM range of the 4th "asdf" by walking textblocks.
    const starts: number[] = []
    e.state.doc.descendants((n, pos) => {
      if (n.isTextblock && n.textContent === 'asdf') starts.push(pos + 1)
      return true
    })
    expect(starts).toHaveLength(4)
    const from = starts[3]
    const anchor = anchorForSelection(e.state.doc, from, 'asdf')
    expect(anchor).not.toBeNull()
    expect(anchor!.start_offset).toBeGreaterThan(0)
    expect(anchor!.prefix).toContain('asdf asdf')
    const r = resolveAnchor(e.state.doc, anchor!)
    expect(r!.from).toBe(from)
    // And the first line still resolves to the first line.
    const a0 = anchorForSelection(e.state.doc, starts[0], 'asdf')!
    expect(resolveAnchor(e.state.doc, a0)!.from).toBe(starts[0])
    // Legacy quote-only anchors keep the old (first-hit) behaviour — stable, not biased.
    expect(resolveAnchor(e.state.doc, { quote: 'asdf' })!.from).toBe(starts[0])
    e.destroy()
  })

  it('a full anchor on a repeated line survives an edit above it (context wins over offset)', () => {
    const e = makeEditor('Intro\n\nasdf\n\nasdf\n\nasdf\n')
    const starts: number[] = []
    e.state.doc.descendants((n, pos) => {
      if (n.isTextblock && n.textContent === 'asdf') starts.push(pos + 1)
      return true
    })
    const anchor = anchorForSelection(e.state.doc, starts[2], 'asdf')!
    e.commands.insertContentAt(1, 'A much longer intro paragraph that shifts every offset. ')
    const after: number[] = []
    e.state.doc.descendants((n, pos) => {
      if (n.isTextblock && n.textContent === 'asdf') after.push(pos + 1)
      return true
    })
    expect(resolveAnchor(e.state.doc, anchor)!.from).toBe(after[2])
    e.destroy()
  })

  it('disambiguates duplicate quotes by prefix/suffix context', () => {
    const e = makeEditor('First stop here. Then travel far. Second stop here. The end.\n')
    const r = resolveAnchor(e.state.doc, {
      quote: 'stop here',
      prefix: 'Second ',
      suffix: '. The end',
    })
    expect(r).not.toBeNull()
    const { text, positions } = buildTextIndex(e.state.doc)
    const secondIdx = text.indexOf('Second stop here')
    expect(r!.from).toBe(positions[secondIdx + 'Second '.length])
    e.destroy()
  })

  it('orphans a quote that no longer exists', () => {
    const e = makeEditor(CORPUS.mixed)
    expect(resolveAnchor(e.state.doc, { quote: 'text that was deleted long ago' })).toBeNull()
    e.destroy()
  })
})

describe('snapToWordBounds', () => {
  // "The quick brown fox jumps." — positions: doc starts at 1 (paragraph
  // open), text starts at 1 in a single-paragraph doc... resolve via search
  // instead of hand-counted offsets so the tests stay robust.
  function posOf(doc: import('@tiptap/pm/model').Node, substr: string): number {
    const { text, positions } = buildTextIndex(doc)
    const i = text.indexOf(substr)
    expect(i).toBeGreaterThanOrEqual(0)
    return positions[i]
  }

  it('expands a mid-word selection outward to whole words', () => {
    const e = makeEditor('The quick brown fox jumps.\n')
    const doc = e.state.doc
    // select "uick bro" (mid-word on both ends)
    const from = posOf(doc, 'uick')
    const to = posOf(doc, 'own') + 3
    const snapped = snapToWordBounds(doc, from, to)
    expect(doc.textBetween(snapped.from, snapped.to, ' ')).toBe('quick brown')
    e.destroy()
  })

  it('leaves an exact word-bounded selection unchanged', () => {
    const e = makeEditor('The quick brown fox jumps.\n')
    const doc = e.state.doc
    const from = posOf(doc, 'quick')
    const to = posOf(doc, 'brown') + 5
    const snapped = snapToWordBounds(doc, from, to)
    expect(snapped).toEqual({ from, to })
    e.destroy()
  })

  it('snaps each end within its own block for cross-block selections', () => {
    const e = makeEditor('First paragraph ends here.\n\nSecond starts now.\n')
    const doc = e.state.doc
    const from = posOf(doc, 'nds here.') // mid-word "ends"
    const to = posOf(doc, 'econd') + 5 // mid-word "Second"
    const snapped = snapToWordBounds(doc, from, to)
    const covered = doc.textBetween(snapped.from, snapped.to, ' ')
    expect(covered.startsWith('ends here.')).toBe(true)
    expect(covered.endsWith('Second')).toBe(true)
    e.destroy()
  })

  it('snapped quotes cover word-into-word marks (the ragged-anchor fix)', () => {
    const e = makeEditor('Some **bold** words in a sentence.\n')
    const doc = e.state.doc
    // drag started inside "bold" and ended inside "words"
    const from = posOf(doc, 'old')
    const to = posOf(doc, 'wor') + 2
    const snapped = snapToWordBounds(doc, from, to)
    expect(normalizeQuote(doc.textBetween(snapped.from, snapped.to, ' '))).toBe('bold words')
    e.destroy()
  })
})

describe('resolveThreads', () => {
  it('splits threads into highlights and orphans, skipping replies; status filtering is the caller’s job', () => {
    const e = makeEditor(CORPUS.mixed)
    const { highlights, orphanedIds } = resolveThreads(e.state.doc, [
      { id: 'a', body: 'x', status: 'open', anchor: { quote: 'point one' } },
      { id: 'b', body: 'x', status: 'review', anchor: { quote: 'vanished text' } },
      { id: 'c', body: 'reply', status: 'open', parent_id: 'a', anchor: { quote: 'point one' } },
      { id: 'd', body: 'x', status: 'resolved', anchor: { quote: 'point two' } },
      { id: 'e', body: 'no anchor', status: 'open' },
    ])
    // 'd' is resolved but still decorated — the page decides whether to pass it.
    expect(highlights.map(h => h.id)).toEqual(['a', 'd'])
    expect(highlights.find(h => h.id === 'd')?.status).toBe('resolved')
    expect(orphanedIds).toEqual(['b'])
    e.destroy()
  })

  it('liveThreadRanges clamps mapped decorations after a deletion shrinks the doc (sweep 2026-09-10)', async () => {
    const { CommentHighlights, commentHighlightsKey, liveThreadRanges } = await import('../apps/inkwell/commentHighlights')
    const e = new Editor({
      extensions: [...contentExtensions(), CommentHighlights.configure({ onThreadClick: () => undefined })],
      content: '# T\n\nfirst\n\nsecond long paragraph here\n\nthird\n',
      contentType: 'markdown',
    })
    const { highlights } = resolveThreads(e.state.doc, [{ id: 'a', body: 'x', status: 'open', anchor: { quote: 'third' } }])
    e.view.dispatch(e.state.tr.setMeta(commentHighlightsKey, highlights))
    // Delete everything from the middle of paragraph 2 to the end.
    e.view.dispatch(e.state.tr.delete(12, e.state.doc.content.size))
    const size = e.state.doc.content.size
    for (const r of liveThreadRanges(e.state)) {
      expect(r.from).toBeLessThanOrEqual(size)
      expect(r.to).toBeLessThanOrEqual(size)
      expect(r.to).toBeGreaterThan(r.from)
      expect(() => e.view.coordsAtPos(r.from)).not.toThrow()
    }
    e.destroy()
  })
})
