/**
 * ScribePage flow tests — the store-rework behaviors, at the logic seams.
 *
 * The heavy children are mocked (RichMarkdownEditor exposes its callbacks as
 * buttons; CoAuthorPanel is a stub): the editor engine has its own suite
 * (scribeAnchors.test.ts), and jsdom cannot host the real embedded ChatPage.
 * What THIS suite pins is the page's contract with the artifact store:
 * debounced autosave with no version churn, the loud conflict path, the
 * threads strip, and human-only resolve.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, fireEvent, waitFor, act } from '@testing-library/react'
import { renderWithProviders } from './helpers'
import ScribePage from '../apps/scribe/ScribePage'
import { StaleDocError } from '../apps/scribe/api'

// ── Mocks ────────────────────────────────────────────────────────────────────

const { saveDocMock, apiMock } = vi.hoisted(() => ({
  saveDocMock: vi.fn(),
  apiMock: {
    artifacts: vi.fn(),
    artifact: vi.fn(),
    createArtifact: vi.fn(),
    artifactComments: vi.fn(),
    postArtifactComment: vi.fn(),
    resolveComment: vi.fn(),
    createChatSlot: vi.fn(),
    chatSlotContext: vi.fn(),
    sendChat: vi.fn(),
  },
}))

vi.mock('../apps/scribe/api', async (orig) => {
  const real = await orig() as object
  return {
    ...real,
    saveDoc: (...a: unknown[]) => saveDocMock(...a),
  }
})

vi.mock('../api/client', () => ({ api: apiMock }))

// Editor stub: surfaces onChange / onComment / threads as pokeable controls.
vi.mock('../apps/scribe/RichMarkdownEditor', () => ({
  default: ({ onChange, onComment, commentThreads, onThreadsResolved }: {
    onChange: (md: string) => void
    onComment?: (q: string) => void
    commentThreads?: { id: string }[]
    onThreadsResolved?: (ids: string[]) => void
  }) => (
    <div data-testid="editor-stub">
      <button type="button" onClick={() => onChange('# doc\n\nedited')}>stub-type</button>
      <button type="button" onClick={() => onComment?.('a quoted passage')}>stub-select</button>
      <button type="button" onClick={() => onThreadsResolved?.(['t2'])}>stub-orphan-t2</button>
      <span data-testid="thread-count">{commentThreads?.length ?? 0}</span>
    </div>
  ),
}))
vi.mock('../apps/scribe/CoAuthorPanel', () => ({
  default: () => <div data-testid="coauthor-stub" />,
}))

const DOC = {
  slug: 'notes', name: 'notes', kind: 'markdown', content: '# doc\n',
  content_sha256: 'sha-0', version: 1, tags: ['scribe'],
}

beforeEach(() => {
  // shouldAdvanceTime: testing-library's findBy*/waitFor poll on REAL timers;
  // frozen fake timers deadlock them (every test times out in setup). This
  // keeps the wall clock creeping for the pollers while advanceTimersByTime
  // still drives the autosave debounce deterministically.
  vi.useFakeTimers({ shouldAdvanceTime: true })
  apiMock.artifacts.mockResolvedValue({ artifacts: [DOC] })
  apiMock.artifact.mockResolvedValue(DOC)
  apiMock.artifactComments.mockResolvedValue({ comments: [] })
  apiMock.resolveComment.mockResolvedValue({})
  saveDocMock.mockResolvedValue({ contentSha256: 'sha-1' })
})

afterEach(() => {
  vi.runOnlyPendingTimers()
  vi.useRealTimers()
  vi.clearAllMocks()
})

async function openDoc() {
  renderWithProviders(<ScribePage />)
  await act(async () => { await vi.runOnlyPendingTimersAsync() })
  fireEvent.click(await screen.findByRole('button', { name: 'notes' }))
  await act(async () => { await vi.runOnlyPendingTimersAsync() })
}

describe('autosave', () => {
  it('debounces edits into one snapshot:false save carrying the held token', async () => {
    await openDoc()
    fireEvent.click(screen.getByText('stub-type'))
    fireEvent.click(screen.getByText('stub-type'))
    expect(saveDocMock).not.toHaveBeenCalled() // still inside the debounce
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(saveDocMock).toHaveBeenCalledTimes(1)
    const [slug, content, opts] = saveDocMock.mock.calls[0]
    expect(slug).toBe('notes')
    expect(content).toContain('edited')
    expect(opts).toMatchObject({ expectedSha256: 'sha-0', snapshot: false })
  })

  it('keeps dirty set when the save fails, so the next keystroke retries', async () => {
    saveDocMock.mockRejectedValueOnce(new Error('network down'))
    await openDoc()
    fireEvent.click(screen.getByText('stub-type'))
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(screen.getByText(/•/)).toBeInTheDocument() // dirty marker survives
    expect(screen.getByText('network down')).toBeInTheDocument()
  })
})

describe('conflict path', () => {
  it('StaleDocError raises the banner and does not clear dirty', async () => {
    saveDocMock.mockRejectedValueOnce(new StaleDocError('stale', 'sha-9'))
    await openDoc()
    fireEvent.click(screen.getByText('stub-type'))
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(screen.getByText(/Changed on the server/)).toBeInTheDocument()
    expect(screen.getByText(/•/)).toBeInTheDocument()
  })

  it('Reload adopts the server copy and clears the banner', async () => {
    saveDocMock.mockRejectedValueOnce(new StaleDocError('stale', 'sha-9'))
    await openDoc()
    fireEvent.click(screen.getByText('stub-type'))
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    apiMock.artifact.mockResolvedValue({ ...DOC, content: '# doc\n\nserver copy', content_sha256: 'sha-9' })
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    expect(screen.queryByText(/Changed on the server/)).not.toBeInTheDocument()
    expect(screen.queryByText(/•/)).not.toBeInTheDocument()
  })
})

describe('threads strip', () => {
  const THREADS = [
    { id: 't1', body: 'tighten this', status: 'open', anchor: { quote: 'q1' } },
    { id: 't2', body: 'source?', status: 'review', anchor: { quote: 'gone' }, anchor_orphaned: false },
    { id: 't3', body: 'done already', status: 'resolved', anchor: { quote: 'q3' } },
    { id: 't4', body: 'a reply', status: 'open', parent_id: 't1', anchor: null },
  ]

  it('renders root unresolved threads with status chips; resolve is wired', async () => {
    apiMock.artifactComments.mockResolvedValue({ comments: THREADS })
    await openDoc()
    expect(screen.getByText('tighten this')).toBeInTheDocument()
    expect(screen.getByText('source?')).toBeInTheDocument()
    expect(screen.queryByText('done already')).not.toBeInTheDocument() // resolved
    expect(screen.queryByText('a reply')).not.toBeInTheDocument() // reply rides parent
    expect(screen.getByTestId('thread-count').textContent).toBe('2')

    fireEvent.click(screen.getAllByRole('button', { name: 'Resolve' })[0])
    await waitFor(() => expect(apiMock.resolveComment).toHaveBeenCalledWith('notes', 't1'))
  })

  it('shows the orphan badge from the editor’s local resolution verdict', async () => {
    apiMock.artifactComments.mockResolvedValue({ comments: THREADS })
    await openDoc()
    expect(screen.queryByText('orphaned')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('stub-orphan-t2'))
    expect(screen.getByText('orphaned')).toBeInTheDocument()
  })
})

describe('comment composer', () => {
  it('send posts an anchored comment, then a nudge turn, then refetches', async () => {
    apiMock.postArtifactComment.mockResolvedValue({})
    apiMock.createChatSlot.mockResolvedValue({ key: 'chat-9', title: 'Scribe: notes' })
    apiMock.chatSlotContext.mockResolvedValue({})
    apiMock.sendChat.mockResolvedValue({ ok: true })
    await openDoc()
    fireEvent.click(screen.getByText('stub-select'))
    const input = screen.getByLabelText('Comment for the co-author')
    fireEvent.change(input, { target: { value: 'find a source' } })
    fireEvent.click(screen.getByRole('button', { name: 'Comment & notify' }))
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    expect(apiMock.postArtifactComment).toHaveBeenCalledWith('notes', {
      text: 'find a source',
      anchor: { quote: 'a quoted passage' },
    })
    expect(apiMock.sendChat).toHaveBeenCalled()
    expect(apiMock.artifactComments.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})
