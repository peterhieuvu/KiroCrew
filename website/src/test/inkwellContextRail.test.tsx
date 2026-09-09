/**
 * Phase-5 context rail: query derivation and memory ranking (pure), plus the
 * component's fetch/render contract against mocked core reads.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import ContextRail, { deriveQuery, extractQueryTerms, rankMemory } from '../apps/inkwell/ContextRail'
import { blockIndexToLine } from '../apps/inkwell/InkwellPage'

const apiMock = vi.hoisted(() => ({
  knowledgeSearch: vi.fn(),
  vectorSemantic: vi.fn(),
}))
vi.mock('../api/client', () => ({ api: apiMock }))
// InkwellPage pulls the whole page graph; we only want blockIndexToLine.
vi.mock('../apps/inkwell/RichMarkdownEditor', () => ({ default: () => null }))
vi.mock('../apps/inkwell/CoAuthorPanel', () => ({ default: () => null }))

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
  it('prefers a substantive selection', () => {
    expect(deriveQuery(MD, 6, 'the anchored comment threads')).toBe('the anchored comment threads')
  })
  it('combines H1 with the nearest heading above the caret', () => {
    expect(deriveQuery(MD, 6, null)).toBe('Inkwell Design Conflict model')
    expect(deriveQuery(MD, 10, null)).toBe('Inkwell Design Comments')
  })
  it('falls back to H1 alone when the caret is above any subheading', () => {
    expect(deriveQuery(MD, 2, null)).toBe('Inkwell Design')
    expect(deriveQuery(MD, null, null)).toBe('Inkwell Design')
  })
  it('uses leading text when there are no headings', () => {
    expect(deriveQuery('just prose here', 0, null)).toBe('just prose here')
  })
})

describe('blockIndexToLine', () => {
  const MD = '# T\n\nfirst para\n\n## H2\n\nsecond para\n'
  it('maps block indices to the source line each block starts on', () => {
    expect(blockIndexToLine(MD, 0)).toBe(0)
    expect(blockIndexToLine(MD, 1)).toBe(2)
    expect(blockIndexToLine(MD, 2)).toBe(4)
    expect(blockIndexToLine(MD, 3)).toBe(6)
  })
  it('clamps past the end', () => {
    expect(blockIndexToLine(MD, 99)).toBe(MD.split('\n').length - 1)
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
    render(<ContextRail markdown={'# Inkwell Design\n\nbody'} caretLine={2} selection={null} onClose={() => undefined} />)
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
    render(<ContextRail markdown={'# Topic'} caretLine={0} selection={null} onClose={() => undefined} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(700) })
    expect(await screen.findByText(/not reachable/)).toBeInTheDocument()
  })
})
