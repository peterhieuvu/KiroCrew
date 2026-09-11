/**
 * Three-way merge for interleaved user + co-author edits (RFC phase 4).
 *
 * All three sides already exist client-side when the conflict fires:
 *   base   — the content the buffer was loaded from (`doc.content`)
 *   ours   — the user's live buffer
 *   theirs — the server's current content (usually the agent's edit)
 *
 * Line-based, built on jsdiff's `diffLines` (already vendored via
 * @pierre/diffs; pinned directly in package.json). Each side's diff against
 * the base becomes a list of line-indexed hunks; hunks touching disjoint
 * base regions apply together, overlapping ones are a CONFLICT.
 *
 * Deliberately conservative, per the phase-4 exit criteria ("conflicts
 * surface, never silently drop"):
 *  - identical changes on both sides merge (take once);
 *  - any other overlap refuses — `clean: false` and the caller keeps the
 *    existing loud-conflict path. No conflict markers are spliced into a
 *    rich-text buffer; the banner is the conflict UI.
 */
import { diffLines } from 'diff'

interface Hunk {
  /** First base line this hunk replaces. */
  start: number
  /** Number of base lines consumed (0 = pure insertion before `start`). */
  baseLen: number
  /** Replacement lines. */
  lines: string[]
}

function splitLines(s: string): string[] {
  // Keep a trailing newline representation stable: split and re-join by \n.
  return s.split('\n')
}

/** Diff `base` → `side` into replace-hunks over base line indices. */
function hunksAgainstBase(base: string, side: string): Hunk[] {
  const parts = diffLines(base.endsWith('\n') ? base : base + '\n', side.endsWith('\n') ? side : side + '\n')
  const hunks: Hunk[] = []
  let baseLine = 0
  let pending: Hunk | null = null
  for (const p of parts) {
    const lineCount = p.count ?? splitLines(p.value.replace(/\n$/, '')).length
    if (p.added) {
      // A pure "\n" added part is jsdiff's way of saying "the side ended here"
      // when the other side deleted down to empty; it inserts NOTHING. Splitting
      // it would yield [''] — a phantom blank line (sweep finding, 2026-09-10).
      const body = p.value.replace(/\n$/, '')
      const lines = body === '' && p.value.length <= 1 ? [] : splitLines(body)
      if (pending) pending.lines.push(...lines)
      else pending = { start: baseLine, baseLen: 0, lines }
    } else if (p.removed) {
      if (pending) pending.baseLen += lineCount
      else pending = { start: baseLine, baseLen: lineCount, lines: [] }
      baseLine += lineCount
    } else {
      if (pending) { hunks.push(pending); pending = null }
      baseLine += lineCount
    }
  }
  if (pending) hunks.push(pending)
  return hunks
}

function overlaps(a: Hunk, b: Hunk): boolean {
  // Insertions (baseLen 0) occupy the boundary point `start`; treat two
  // insertions at the same point as overlapping (ordering is ambiguous),
  // and an insertion inside another hunk's consumed range as overlapping.
  const aEnd = a.start + Math.max(a.baseLen, 0)
  const bEnd = b.start + Math.max(b.baseLen, 0)
  if (a.baseLen === 0 && b.baseLen === 0) return a.start === b.start
  return a.start < bEnd && b.start < aEnd
}

function sameChange(a: Hunk, b: Hunk): boolean {
  return a.start === b.start && a.baseLen === b.baseLen
    && a.lines.length === b.lines.length
    && a.lines.every((l, i) => l === b.lines[i])
}

export interface MergeResult {
  merged: string
  clean: boolean
}

/** Merge two descendants of `base`. `clean: false` leaves `merged` = ours. */
export function threeWayMerge(base: string, ours: string, theirs: string): MergeResult {
  if (ours === theirs) return { merged: ours, clean: true }
  if (base === ours) return { merged: theirs, clean: true }
  if (base === theirs) return { merged: ours, clean: true }

  const ourHunks = hunksAgainstBase(base, ours)
  const theirHunks = hunksAgainstBase(base, theirs)

  // Conflict scan: any our-hunk overlapping any their-hunk (unless the
  // change is byte-identical, which collapses to one application).
  const apply: Array<Hunk & { side: 'ours' | 'theirs' }> = []
  const consumedTheirs = new Set<number>()
  for (const oh of ourHunks) {
    for (let i = 0; i < theirHunks.length; i++) {
      const th = theirHunks[i]
      if (overlaps(oh, th)) {
        if (sameChange(oh, th)) {
          consumedTheirs.add(i) // identical: apply once (as ours)
        } else {
          return { merged: ours, clean: false }
        }
      }
    }
    apply.push({ ...oh, side: 'ours' })
  }
  theirHunks.forEach((th, i) => {
    if (!consumedTheirs.has(i)) apply.push({ ...th, side: 'theirs' })
  })

  // Apply back-to-front so earlier hunk offsets stay valid.
  apply.sort((a, b) => b.start - a.start || (b.baseLen - a.baseLen))
  const out = splitLines(base)
  for (const h of apply) {
    out.splice(h.start, h.baseLen, ...h.lines)
  }
  return { merged: out.join('\n'), clean: true }
}
