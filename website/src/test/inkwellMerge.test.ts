/**
 * Phase-4 three-way merge: interleaved user + co-author edits.
 * Conservative contract: disjoint hunks merge; overlaps refuse loudly.
 */
import { describe, it, expect } from 'vitest'
import { threeWayMerge } from '../apps/inkwell/merge'

const BASE = [
  '# Title',
  '',
  'First paragraph about the design.',
  '',
  'Second paragraph with details.',
  '',
  'Third paragraph wrapping up.',
].join('\n')

describe('threeWayMerge', () => {
  it('trivial fast paths', () => {
    expect(threeWayMerge(BASE, BASE, BASE)).toEqual({ merged: BASE, clean: true })
    const edited = BASE.replace('First', 'Opening')
    expect(threeWayMerge(BASE, BASE, edited)).toEqual({ merged: edited, clean: true })
    expect(threeWayMerge(BASE, edited, BASE)).toEqual({ merged: edited, clean: true })
    expect(threeWayMerge(BASE, edited, edited)).toEqual({ merged: edited, clean: true })
  })

  it('merges disjoint single-line edits from both sides', () => {
    const ours = BASE.replace('First paragraph about the design.', 'First paragraph, rewritten by the user.')
    const theirs = BASE.replace('Third paragraph wrapping up.', 'Third paragraph, tightened by the agent.')
    const r = threeWayMerge(BASE, ours, theirs)
    expect(r.clean).toBe(true)
    expect(r.merged).toContain('rewritten by the user')
    expect(r.merged).toContain('tightened by the agent')
    expect(r.merged).toContain('Second paragraph with details.')
  })

  it('merges an insertion on one side with an edit on the other', () => {
    const ours = BASE.replace('# Title', '# Title\n\nA brand new intro line.')
    const theirs = BASE.replace('Second paragraph with details.', 'Second paragraph, expanded.')
    const r = threeWayMerge(BASE, ours, theirs)
    expect(r.clean).toBe(true)
    expect(r.merged).toContain('A brand new intro line.')
    expect(r.merged).toContain('Second paragraph, expanded.')
  })

  it('merges a deletion against a distant edit', () => {
    const ours = BASE.replace('\n\nSecond paragraph with details.', '')
    const theirs = BASE.replace('Third paragraph wrapping up.', 'Third paragraph, done.')
    const r = threeWayMerge(BASE, ours, theirs)
    expect(r.clean).toBe(true)
    expect(r.merged).not.toContain('Second paragraph')
    expect(r.merged).toContain('Third paragraph, done.')
  })

  it('refuses when both sides edit the same line differently', () => {
    const ours = BASE.replace('Second paragraph with details.', 'Second paragraph — user version.')
    const theirs = BASE.replace('Second paragraph with details.', 'Second paragraph — agent version.')
    const r = threeWayMerge(BASE, ours, theirs)
    expect(r.clean).toBe(false)
    expect(r.merged).toBe(ours) // caller keeps the buffer; nothing dropped
  })

  it('refuses edit-vs-delete of the same region', () => {
    const ours = BASE.replace('Second paragraph with details.', 'Second paragraph, edited.')
    const theirs = BASE.replace('\n\nSecond paragraph with details.', '')
    expect(threeWayMerge(BASE, ours, theirs).clean).toBe(false)
  })

  it('applies identical changes once instead of conflicting', () => {
    const same = BASE.replace('First paragraph about the design.', 'First paragraph, identically retyped.')
    const theirs = same.replace('Third paragraph wrapping up.', 'Third, by agent.')
    const r = threeWayMerge(BASE, same, theirs)
    expect(r.clean).toBe(true)
    expect(r.merged).toContain('identically retyped')
    expect(r.merged.match(/identically retyped/g)).toHaveLength(1)
    expect(r.merged).toContain('Third, by agent.')
  })

  it('refuses ambiguous same-point insertions', () => {
    const ours = BASE.replace('# Title', '# Title\nUser line.')
    const theirs = BASE.replace('# Title', '# Title\nAgent line.')
    expect(threeWayMerge(BASE, ours, theirs).clean).toBe(false)
  })

  it('handles missing trailing newlines without phantom hunks', () => {
    const r = threeWayMerge('a\nb', 'a\nb\nc', 'z\nb')
    expect(r.clean).toBe(true)
    expect(r.merged.split('\n')).toEqual(['z', 'b', 'c'])
  })

  it('theirs deletes the tail to empty while ours edits the head: no phantom blank line (sweep 2026-09-10)', () => {
    const r = threeWayMerge('# T\n\nintro\n\ntail para\n', '# Title\n\nintro\n\ntail para\n', '# T\n\nintro\n')
    expect(r.clean).toBe(true)
    expect(r.merged).toBe('# Title\n\nintro\n')
  })
})
