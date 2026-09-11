/**
 * Phase-5 context rail: query derivation and memory ranking (pure), plus the
 * component's fetch/render contract against mocked core reads.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import ContextRail, { deriveQuery, extractQueryTerms, rankMemory } from '../apps/inkwell/ContextRail'
import { headingContext } from '../apps/inkwell/headings'
import { Editor } from '@tiptap/core'
import { contentExtensions } from '../apps/inkwell/extensions'

const apiMock = vi.hoisted(() => ({
  knowledgeSearch: vi.fn(),
  vectorSemantic: vi.fn(),
}))
vi.mock('../api/client', () => ({ api: apiMock }))

describe('extractQueryTerms', () => {
  it('keeps meaningful words, drops stopwords/short tokens, dedups, caps', () => {
    expect(extractQueryTerms('This is about the Artifact Store and the artifact store design'))
      .toEqual(['artifact', 'store', 'design'])
    expect(extractQueryTerms('a b c')).toEqual([])
    expect(extractQueryTerms(Array.from({ length: 20 }, (_, i) => `word${i}`).join(' '))).toHaveLength(8)
  })
})

describe('deriveQuery', () => {
  const MD = '# Inkwell Design\n\nIntro text.\n\n## Conflict model\n\nBody under conflict.\n\n## Comments\n\nBody under comments.\n'
  const H1 = 'Inkwell Design'
  it('prefers a substantive selection', () => {
    expect(deriveQuery(MD, { h1: H1, nearest: 'Conflict model' }, 'the anchored comment threads')).toBe('the anchored comment threads')
  })
  it('combines H1 with the nearest heading above the caret', () => {
    expect(deriveQuery(MD, { h1: H1, nearest: 'Conflict model' }, null)).toBe('Inkwell Design Conflict model')
    expect(deriveQuery(MD, { h1: H1, nearest: 'Comments' }, null)).toBe('Inkwell Design Comments')
  })
  it('falls back to H1 alone when the caret is above any subheading', () => {
    expect(deriveQuery(MD, { h1: H1, nearest: H1 }, null)).toBe('Inkwell Design')
    expect(deriveQuery(MD, { h1: H1, nearest: null }, null)).toBe('Inkwell Design')
    expect(deriveQuery(MD, null, null)).toBe(MD.slice(0, 400))
  })
  it('uses leading text when there are no headings', () => {
    expect(deriveQuery('just prose here', { h1: null, nearest: null }, null)).toBe('just prose here')
  })
})

describe('headingContext (schema-true, sweep regression 2026-09-10)', () => {
  function docOf(md: string) {
    const e = new Editor({ extensions: contentExtensions(), content: md, contentType: 'markdown' })
    const doc = e.state.doc
    return { doc, destroy: () => e.destroy() }
  }
  it('nearest heading survives multi-line blocks (fenced code, blockquote) above the caret', () => {
    // Blocks: 0 H1, 1 H2 Setup, 2 fence (3 source lines), 3 quote (2 lines), 4 H2 Usage, 5 para
    const { doc, destroy } = docOf('# T\n\n## Setup\n\n```sh\nline a\nline b\n```\n\n> q1\n> q2\n\n## Usage\n\nBody.\n')
    expect(headingContext(doc, 3)).toEqual({ h1: 'T', nearest: 'Setup' })   // inside the quote
    expect(headingContext(doc, 5)).toEqual({ h1: 'T', nearest: 'Usage' })   // the body paragraph
    expect(headingContext(doc, 0)).toEqual({ h1: 'T', nearest: 'T' })
    destroy()
  })
  it('no H1: the first heading stands in; no headings: nulls', () => {
    const a = docOf('## Only H2\n\ntext\n'); expect(headingContext(a.doc, 1)).toEqual({ h1: 'Only H2', nearest: 'Only H2' }); a.destroy()
    const b = docOf('plain\n\ntext\n'); expect(headingContext(b.doc, 1)).toEqual({ h1: null, nearest: null }); b.destroy()
  })
})

describe('rankMemory', () => {
  const ENTRIES = [
    { key: 'project.inkwell.merge', value: 'three-way merge decision' },
    { key: 'project.other.thing', value: 'unrelated note' },
    { key: 'user.pref.editor', value: 'likes merge banners and inkwell' },
  ]
  it('scores by term hits across key and value, drops zero-hit entries', () => {
    const r = rankMemory(ENTRIES, ['inkwell', 'merge'])
    expect(r.map(e => e.key)).toEqual(['project.inkwell.merge', 'user.pref.editor'])
  })
  it('returns nothing for no terms', () => {
    expect(rankMemory(ENTRIES, [])).toEqual([])
  })
})

describe('<ContextRail />', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    apiMock.knowledgeSearch.mockResolvedValue({ results: [
      { id: 'k1', title: 'RFC: Inkwell', summary: 'the design', source_name: 'workspace' },
    ] })
    apiMock.vectorSemantic.mockResolvedValue({ entries: [
      { key: 'project.inkwell.decision', value: 'hybrid on the artifact store' },
      { key: 'noise', value: 'nothing relevant' },
    ] })
  })
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

  it('fetches after the debounce and renders knowledge + ranked memory cards', async () => {
    render(<ContextRail markdown={'# Inkwell Design\n\nbody'} caret={{ h1: 'Inkwell Design', nearest: 'Inkwell Design' }} selection={null} onClose={() => undefined} />)
    expect(apiMock.knowledgeSearch).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })
    expect(apiMock.knowledgeSearch).toHaveBeenCalledWith('Inkwell Design')
    expect(await screen.findByText('RFC: Inkwell')).toBeInTheDocument()
    expect(screen.getByText('project.inkwell.decision')).toBeInTheDocument()
    expect(screen.queryByText('noise')).not.toBeInTheDocument()
  })

  it('surfaces an unavailability notice when both sources fail', async () => {
    apiMock.knowledgeSearch.mockRejectedValue(new Error('403'))
    apiMock.vectorSemantic.mockRejectedValue(new Error('403'))
    render(<ContextRail markdown={'# Topic'} caret={{ h1: 'Topic', nearest: 'Topic' }} selection={null} onClose={() => undefined} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })
    expect(await screen.findByText(/not reachable/)).toBeInTheDocument()
  })
})
