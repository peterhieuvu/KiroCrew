/**
 * Anchor resolution: artifact comment anchors → ProseMirror position ranges.
 *
 * An anchor is quote-based with context (quote / prefix / suffix / offsets /
 * the version it was made against) and an `anchor_orphaned` flag the SERVER
 * maintains by substring-rescanning on every content write. This module does
 * the editor-side half: locate the quote in the LOADED document and return
 * PM positions for decoration.
 *
 * Resolution ladder (RFC "Risks" — exact-offset-then-quote-search):
 *   1. Offsets, verified: if doc text at [start, end) equals the quote,
 *      trust the offsets (fast path — nothing moved).
 *   2. Quote search: find occurrences of the quote in the doc text. One hit
 *      wins outright; multiple hits are disambiguated by prefix/suffix
 *      context score, then by distance to the recorded offsets.
 *   3. Miss: orphaned. The caller renders the thread without a highlight —
 *      the same verdict the server's rescan reaches, computed locally so a
 *      freshly-typed buffer degrades identically before any save.
 *
 * Text model: the searchable string is the concatenation of the doc's text
 * nodes with ONE space at each block boundary and all whitespace runs
 * collapsed — matching how InkwellPage builds quotes on creation
 * (`textBetween(from, to, ' ')` + collapse). The index keeps a map from
 * searchable-string offsets back to PM positions.
 *
 * KNOWN LIMIT (documented in the RFC): the server's orphan rescan checks the
 * quote against MARKDOWN SOURCE, so a quote spanning inline formatting
 * (`**bold**`) can be orphaned server-side while still resolvable here.
 * Quote-first anchoring degrades gracefully; the mismatch is a candidate
 * upstream refinement, not something to paper over locally.
 */
import type { Node as PMNode } from '@tiptap/pm/model'

export interface CommentAnchor {
  quote: string
  prefix?: string | null
  suffix?: string | null
  start_offset?: number | null
  end_offset?: number | null
}

export interface ResolvedAnchor {
  /** ProseMirror positions for a decoration. */
  from: number
  to: number
}

/** Flatten a PM doc into a searchable string + per-char PM positions.
 *
 *  Model matches quote construction at comment-create time
 *  (`textBetween(from, to, ' ')` + whitespace collapse):
 *  - text inside a block concatenates directly — inline mark boundaries
 *    (`foo**bar**` → "foobar") contribute NO separator;
 *  - a BLOCK boundary contributes one space;
 *  - whitespace runs collapse to a single space.
 */
export function buildTextIndex(doc: PMNode): { text: string; positions: number[] } {
  const textArr: string[] = []
  const positions: number[] = []
  let sepPos = -1 // PM position a pending separator maps back to; -1 = none
  let started = false // suppress any separator before the first real char
  doc.descendants((node, pos) => {
    if (node.isTextblock && started && sepPos < 0) {
      // Entering a new block after emitted text: one separator, attributed
      // to the block's opening position so a match ending at a block edge
      // still maps to a real place.
      sepPos = pos
    }
    if (!node.isText || !node.text) return true
    for (let i = 0; i < node.text.length; i++) {
      const ch = node.text[i]
      const chPos = pos + i
      if (/\s/.test(ch)) {
        if (started && sepPos < 0) sepPos = chPos
        continue
      }
      if (started && sepPos >= 0) {
        textArr.push(' ')
        positions.push(sepPos)
      }
      sepPos = -1
      textArr.push(ch)
      positions.push(chPos)
      started = true
    }
    return true
  })
  return { text: textArr.join(''), positions }
}

/** Collapse whitespace the same way quotes are built. */
export function normalizeQuote(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function findAll(haystack: string, needle: string): number[] {
  const out: number[] = []
  let i = haystack.indexOf(needle)
  while (i !== -1) {
    out.push(i)
    i = haystack.indexOf(needle, i + 1)
  }
  return out
}

/** Score a candidate hit by how much of the prefix/suffix context matches. */
function contextScore(
  text: string,
  hit: number,
  quoteLen: number,
  prefix: string | null | undefined,
  suffix: string | null | undefined,
): number {
  let score = 0
  if (prefix) {
    const p = normalizeQuote(prefix)
    const before = text.slice(Math.max(0, hit - p.length), hit)
    // Count the matched tail of the prefix.
    for (let k = 1; k <= Math.min(p.length, before.length); k++) {
      if (p.slice(-k) === before.slice(-k)) score = k
      else break
    }
  }
  if (suffix) {
    const s = normalizeQuote(suffix)
    const after = text.slice(hit + quoteLen, hit + quoteLen + s.length)
    for (let k = 1; k <= Math.min(s.length, after.length); k++) {
      if (s.slice(0, k) === after.slice(0, k)) score += k
      else break
    }
  }
  return score
}

/** Resolve one anchor against a doc. Returns null when orphaned. */
export function resolveAnchor(doc: PMNode, anchor: CommentAnchor): ResolvedAnchor | null {
  const quote = normalizeQuote(anchor.quote ?? '')
  if (!quote) return null
  const { text, positions } = buildTextIndex(doc)

  const hits = findAll(text, quote)
  if (hits.length === 0) return null

  let hit: number
  if (hits.length === 1) {
    hit = hits[0]
  } else {
    // Disambiguate: best context score, then nearest to the recorded offset.
    const ref = anchor.start_offset ?? 0
    hit = hits
      .map(h => ({ h, score: contextScore(text, h, quote.length, anchor.prefix, anchor.suffix) }))
      .sort((a, b) => b.score - a.score || Math.abs(a.h - ref) - Math.abs(b.h - ref))[0].h
  }

  const from = positions[hit]
  const lastIdx = hit + quote.length - 1
  const to = positions[lastIdx] + 1
  return { from, to }
}

/** Snap a selection range outward to word boundaries within its textblocks.
 *
 *  Live-verification finding (2026-09-08): free-hand drags produce ragged
 *  anchors — a quote that under-covers its sentence leaves remnants when a
 *  suggestion replaces the anchored range. Snapping each end outward to the
 *  nearest whitespace makes quotes cover whole words, so proposals replace
 *  what a reader would consider "the passage".
 *
 *  Each end snaps within its OWN textblock (a cross-block selection cannot
 *  expand past block edges). Positions are clamped to the block's text-node
 *  span; inline leaf nodes (hard breaks) bound the walk like whitespace.
 */
export function snapToWordBounds(
  doc: PMNode,
  from: number,
  to: number,
): { from: number; to: number } {
  const clamp = (n: number) => Math.max(0, Math.min(n, doc.content.size))
  let a = clamp(from)
  let b = clamp(Math.max(from, to))

  const $a = doc.resolve(a)
  if ($a.parent.isTextblock) {
    const text = $a.parent.textContent
    let off = Math.min($a.parentOffset, text.length)
    while (off > 0 && !/\s/.test(text[off - 1])) off -= 1
    a = $a.start() + off
  }

  const $b = doc.resolve(b)
  if ($b.parent.isTextblock) {
    const text = $b.parent.textContent
    let off = Math.min($b.parentOffset, text.length)
    while (off < text.length && !/\s/.test(text[off])) off += 1
    b = $b.start() + off
  }

  return { from: a, to: Math.max(a, b) }
}

export interface CommentThread {
  id: string
  body: string
  status: string
  is_agent?: boolean
  parent_id?: string | null
  anchor?: CommentAnchor | null
  anchor_orphaned?: boolean
}

export interface ThreadHighlight {
  id: string
  status: string
  from: number
  to: number
}

/** Resolve every ROOT thread with an anchor; replies ride their parent.
 *  Which statuses to include is the CALLER's decision (the page's
 *  Show-resolved toggle) — this function decorates whatever it is handed.
 *  Returns highlights for resolvable threads and ids of orphaned ones. */
export function resolveThreads(
  doc: PMNode,
  comments: CommentThread[],
): { highlights: ThreadHighlight[]; orphanedIds: string[] } {
  const highlights: ThreadHighlight[] = []
  const orphanedIds: string[] = []
  for (const c of comments) {
    if (c.parent_id || !c.anchor) continue
    const r = resolveAnchor(doc, c.anchor)
    if (r) highlights.push({ id: c.id, status: c.status, from: r.from, to: r.to })
    else orphanedIds.push(c.id)
  }
  return { highlights, orphanedIds }
}
