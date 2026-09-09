/**
 * Phase-3 proposed edits: suggestion-fence parsing and apply-at-anchor,
 * against a real headless Tiptap editor (same extension set as the app).
 */
import { describe, it, expect } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { parseSuggestion, applySuggestion } from '../apps/inkwell/suggestions'

function makeEditor(markdown: string): Editor {
  return new Editor({
    extensions: [StarterKit.configure({ link: { openOnClick: false } }), Markdown],
    content: markdown,
    contentType: 'markdown',
  })
}

describe('parseSuggestion', () => {
  it('extracts the fence body, dropping the closing-fence newline', () => {
    expect(parseSuggestion('Tightened:\n```suggestion\nnew text\n```\nthanks')).toBe('new text')
  })
  it('keeps internal newlines (multi-line proposals)', () => {
    expect(parseSuggestion('```suggestion\nline one\nline two\n```')).toBe('line one\nline two')
  })
  it('returns null when no fence exists', () => {
    expect(parseSuggestion('just prose with ```code\nfence\n```')).toBeNull()
    expect(parseSuggestion('')).toBeNull()
  })
  it('an empty fence is an empty replacement (deletion), not null', () => {
    expect(parseSuggestion('```suggestion\n```')).toBe('')
  })
})

describe('applySuggestion', () => {
  it('splices a single-line replacement at the anchored range as plain text', () => {
    const e = makeEditor('# T\n\nThe quick brown fox jumps.\n')
    const ok = applySuggestion(e, { quote: 'quick brown fox' }, 'lazy dog')
    expect(ok).toBe(true)
    expect(e.getMarkdown()).toContain('The lazy dog jumps.')
    e.destroy()
  })

  it('re-resolves at apply time: still lands after an intervening edit above', () => {
    const e = makeEditor('# T\n\nIntro paragraph.\n\nReplace this exact clause here.\n')
    e.commands.insertContentAt(5, 'MOVED ') // shift everything below
    const ok = applySuggestion(e, { quote: 'this exact clause' }, 'that better clause')
    expect(ok).toBe(true)
    expect(e.getMarkdown()).toContain('Replace that better clause here.')
    e.destroy()
  })

  it('refuses when the anchor no longer resolves', () => {
    const e = makeEditor('# T\n\nSome content.\n')
    const before = e.getMarkdown()
    expect(applySuggestion(e, { quote: 'vanished passage' }, 'anything')).toBe(false)
    expect(e.getMarkdown()).toBe(before) // untouched on refusal
    e.destroy()
  })

  it('inserts a multi-line replacement as markdown blocks', () => {
    const e = makeEditor('# T\n\nOld paragraph to replace.\n')
    const ok = applySuggestion(
      e,
      { quote: 'Old paragraph to replace.' },
      'New first line.\n\n- and a bullet',
    )
    expect(ok).toBe(true)
    const md = e.getMarkdown()
    expect(md).toContain('New first line.')
    expect(md).toMatch(/[-*] and a bullet/)
    expect(md).not.toContain('Old paragraph')
    e.destroy()
  })

  it('fires the editor update path (autosave contract)', () => {
    const e = makeEditor('# T\n\nWatch this space.\n')
    let updates = 0
    e.on('update', () => { updates += 1 })
    applySuggestion(e, { quote: 'Watch this space.' }, 'Watched.')
    expect(updates).toBe(1)
    e.destroy()
  })
})
