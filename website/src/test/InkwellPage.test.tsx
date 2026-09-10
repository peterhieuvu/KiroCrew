/**
 * InkwellPage flow tests — the store-rework behaviors, at the logic seams.
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
import InkwellPage from '../apps/inkwell/InkwellPage'
import { StaleDocError } from '../apps/inkwell/api'

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

vi.mock('../apps/inkwell/api', async (orig) => {
  const real = await orig() as object
  return {
    ...real,
    saveDoc: (...a: unknown[]) => saveDocMock(...a),
  }
})

vi.mock('../api/client', () => ({ api: apiMock }))

// Editor stub: surfaces onChange / onComment / threads as pokeable controls,
// and (phase 3) an imperative applySuggestion recorded on the mock.
const applySuggestionMock = vi.hoisted(() => vi.fn().mockReturnValue(true))
vi.mock('../apps/inkwell/RichMarkdownEditor', async () => {
  const React = await import('react')
  return {
    default: React.forwardRef(function Stub({ value, onChange, onComment, commentThreads, onThreadsResolved, onThreadClick, onCaretContext }: {
      value: string
      onChange: (md: string) => void
      onComment?: (a: { quote: string }, at: { x: number; y: number }) => void
      commentThreads?: { id: string }[]
      onThreadsResolved?: (ids: string[]) => void
      onThreadClick?: (id: string) => void
      onCaretContext?: (c: { blockIndex: number; selection: string | null; threadId: string | null }) => void
    }, ref: React.Ref<unknown>) {
      React.useImperativeHandle(ref, () => ({
        applySuggestion: applySuggestionMock,
        threadAnchorRect: () => ({ x: 10, y: 20, top: 15 }),
      }))
      return (
        <div data-testid="editor-stub">
          <span data-testid="editor-value">{value}</span>
          <button type="button" onClick={() => onChange(value.replace('omega', 'omega user-edit'))}>stub-type</button>
          <button type="button" onClick={() => onComment?.({ quote: 'a quoted passage', prefix: 'ctx ', suffix: ' more', start_offset: 4, end_offset: 20 }, { x: 40, y: 60 })}>stub-select</button>
          <button type="button" onClick={() => onThreadsResolved?.(['t2'])}>stub-orphan-t2</button>
          {commentThreads?.map(t => (
            <button key={t.id} type="button" onClick={() => onThreadClick?.(t.id)}>{`stub-open-${t.id}`}</button>
          ))}
          <button type="button" onClick={() => onCaretContext?.({ blockIndex: 0, selection: null, threadId: 't1' })}>stub-caret-in-t1</button>
          <button type="button" onClick={() => onCaretContext?.({ blockIndex: 0, selection: 'some words', threadId: null })}>stub-range-select</button>
          <span data-testid="thread-count">{commentThreads?.length ?? 0}</span>
        </div>
      )
    }),
  }
})
vi.mock('../apps/inkwell/CoAuthorPanel', () => ({
  default: () => <div data-testid="coauthor-stub" />,
}))

const DOC = {
  slug: 'notes', name: 'notes', kind: 'markdown',
  content: '# doc\n\nalpha line.\n\nomega line.\n',
  content_sha256: 'sha-0', version: 1, tags: ['inkwell'],
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
  renderWithProviders(<InkwellPage />)
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
    expect(content).toContain('user-edit')
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
  // Post-phase-4, a bare 409 first attempts a 3-way merge; the loud banner
  // is now the OVERLAP outcome, so these tests make the server side collide
  // with the user's edit (same 'omega' line, different text).
  const COLLIDING = { ...DOC, content: '# doc\n\nalpha line.\n\nomega agent-version.\n', content_sha256: 'sha-9' }

  it('StaleDocError with overlapping edits raises the banner and does not clear dirty', async () => {
    saveDocMock.mockRejectedValueOnce(new StaleDocError('stale', 'sha-9'))
    await openDoc()
    apiMock.artifact.mockResolvedValue(COLLIDING)
    fireEvent.click(screen.getByText('stub-type'))
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(screen.getByText(/Changed on the server/)).toBeInTheDocument()
    expect(screen.getByText(/•/)).toBeInTheDocument()
  })

  it('Reload adopts the server copy and clears the banner', async () => {
    saveDocMock.mockRejectedValueOnce(new StaleDocError('stale', 'sha-9'))
    await openDoc()
    apiMock.artifact.mockResolvedValue(COLLIDING)
    fireEvent.click(screen.getByText('stub-type'))
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
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

  it('passes root unresolved threads to the editor; anchored ones are NOT listed in a strip', async () => {
    apiMock.artifactComments.mockResolvedValue({ comments: THREADS })
    await openDoc()
    // Editor receives exactly the root unresolved threads (t1, t2).
    expect(screen.getByTestId('thread-count').textContent).toBe('2')
    expect(screen.getByTestId('inkwell-thread-count').textContent).toBe('2 threads')
    // No bottom strip for anchored threads; bodies appear only via the popover.
    expect(screen.queryByText('tighten this')).not.toBeInTheDocument()
    expect(screen.queryByTestId('inkwell-orphaned-threads')).not.toBeInTheDocument()
  })

  it('opening a thread shows its popover with the root, replies, and Resolve', async () => {
    apiMock.artifactComments.mockResolvedValue({ comments: THREADS })
    await openDoc()
    fireEvent.click(screen.getByText('stub-open-t1'))
    const pop = await screen.findByTestId('inkwell-thread-popover')
    expect(pop).toHaveTextContent('tighten this')
    expect(pop).toHaveTextContent('a reply') // reply rendered in-thread
    expect(pop).not.toHaveTextContent('done already')
    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }))
    await waitFor(() => expect(apiMock.resolveComment).toHaveBeenCalledWith('notes', 't1'))
  })

  it('orphaned threads fall back to a list; the badge follows the editor’s verdict', async () => {
    apiMock.artifactComments.mockResolvedValue({ comments: THREADS })
    await openDoc()
    expect(screen.queryByTestId('inkwell-orphaned-threads')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('stub-orphan-t2'))
    const list = screen.getByTestId('inkwell-orphaned-threads')
    expect(list).toHaveTextContent('source?')
    expect(list).toHaveTextContent('orphaned')
    expect(list).not.toHaveTextContent('tighten this') // anchored ones stay out
  })

  it('Show-resolved toggle reveals resolved roots; the open-count badge is unaffected; Reopen is wired', async () => {
    apiMock.artifactComments.mockResolvedValue({ comments: THREADS })
    ;(apiMock as Record<string, unknown>).reopenComment = vi.fn().mockResolvedValue({})
    await openDoc()
    expect(screen.getByTestId('thread-count').textContent).toBe('2') // editor gets open roots only
    const toggle = screen.getByTestId('inkwell-show-resolved')
    expect(toggle).toHaveTextContent('1 resolved')
    fireEvent.click(toggle)
    expect(screen.getByTestId('thread-count').textContent).toBe('3') // t3 now decorated
    expect(screen.getByTestId('inkwell-thread-count').textContent).toBe('2 threads') // badge = open only
    fireEvent.click(screen.getByText('stub-open-t3'))
    const pop = await screen.findByTestId('inkwell-thread-popover')
    expect(pop).toHaveTextContent('done already')
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }))
    await waitFor(() => expect((apiMock as Record<string, ReturnType<typeof vi.fn>>).reopenComment).toHaveBeenCalledWith('notes', 't3'))
  })
})

const apiMockExt = apiMock as typeof apiMock & { replyArtifactComment: ReturnType<typeof vi.fn> }

describe('proposed edits (phase 3)', () => {
  const PROPOSAL_THREADS = [
    {
      id: 'p1', body: 'tighten this', status: 'review',
      anchor: { quote: 'the anchored passage' },
    },
    {
      id: 'p2', body: 'Here you go:\n```suggestion\ntightened text\n```',
      status: 'review', parent_id: 'p1', anchor: null, is_agent: true,
    },
    { id: 'n1', body: 'plain question, no proposal', status: 'open', anchor: { quote: 'q' } },
  ]

  beforeEach(() => {
    apiMockExt.replyArtifactComment = vi.fn().mockResolvedValue({})
    ;(apiMock as Record<string, unknown>).replyArtifactComment = apiMockExt.replyArtifactComment
    apiMock.artifactComments.mockResolvedValue({ comments: PROPOSAL_THREADS })
    applySuggestionMock.mockClear().mockReturnValue(true)
  })

  it('a proposal thread’s popover shows the suggestion preview + Accept/Reject; a plain thread shows Resolve', async () => {
    await openDoc()
    fireEvent.click(screen.getByText('stub-open-p1'))
    const pop = await screen.findByTestId('inkwell-thread-popover')
    expect(pop).toHaveTextContent('🤖 co-author') // agent reply attributed
    expect(screen.getByTestId('inkwell-suggestion-preview')).toHaveTextContent('tightened text')
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('stub-open-n1'))
    expect(await screen.findByRole('button', { name: 'Resolve' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Accept' })).not.toBeInTheDocument()
  })

  it('Accept applies at the ROOT anchor, replies, resolves, refetches', async () => {
    await openDoc()
    fireEvent.click(screen.getByText('stub-open-p1'))
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    expect(applySuggestionMock).toHaveBeenCalledWith(
      { quote: 'the anchored passage' }, 'tightened text',
    )
    expect(apiMockExt.replyArtifactComment).toHaveBeenCalledWith('notes', 'p1', { text: 'Applied the suggestion.' })
    expect(apiMock.resolveComment).toHaveBeenCalledWith('notes', 'p1')
  })

  it('Accept on an orphaned anchor surfaces the error and leaves the thread open', async () => {
    applySuggestionMock.mockReturnValue(false)
    await openDoc()
    fireEvent.click(screen.getByText('stub-open-p1'))
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }))
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    expect(screen.getByText(/Could not apply/)).toBeInTheDocument()
    expect(apiMock.resolveComment).not.toHaveBeenCalled()
  })

  it('Reject replies and resolves without touching the editor', async () => {
    await openDoc()
    fireEvent.click(screen.getByText('stub-open-p1'))
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }))
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    expect(applySuggestionMock).not.toHaveBeenCalled()
    expect(apiMockExt.replyArtifactComment).toHaveBeenCalledWith('notes', 'p1', { text: 'Declined the suggestion.' })
    expect(apiMock.resolveComment).toHaveBeenCalledWith('notes', 'p1')
  })
})

describe('new-document popover', () => {
  it('one pane collects name + optional path and creates on Enter', async () => {
    apiMock.createArtifact.mockResolvedValue({ slug: 'fresh' })
    apiMock.artifact.mockResolvedValue({ ...DOC, slug: 'fresh', name: 'fresh' })
    renderWithProviders(<InkwellPage />)
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    fireEvent.click(screen.getByRole('button', { name: 'New document' }))
    const pane = screen.getByTestId('inkwell-new-doc')
    fireEvent.change(screen.getByLabelText('Document name'), { target: { value: 'fresh' } })
    fireEvent.change(screen.getByLabelText('Backing file path'), { target: { value: '/repo/docs/fresh.md' } })
    fireEvent.keyDown(screen.getByLabelText('Backing file path'), { key: 'Enter' })
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    expect(apiMock.createArtifact).toHaveBeenCalledWith(expect.objectContaining({
      name: 'fresh', kind: 'markdown', source_path: '/repo/docs/fresh.md',
    }))
    expect(pane).not.toBeInTheDocument() // closed after create
  })
})

describe('nudge coalescing', () => {
  async function postComment() {
    fireEvent.click(screen.getByText('stub-select'))
    const input = screen.getByLabelText('Comment for the co-author')
    fireEvent.change(input, { target: { value: 'note' } })
    fireEvent.click(screen.getByRole('button', { name: 'Comment & notify' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
  }

  beforeEach(() => {
    apiMock.postArtifactComment.mockResolvedValue({})
    apiMock.createChatSlot.mockResolvedValue({ key: 'chat-9', title: 'Inkwell: notes' })
    apiMock.chatSlotContext.mockResolvedValue({})
    apiMock.sendChat.mockResolvedValue({ ok: true })
  })

  it('three quick comments post three times but nudge exactly once', async () => {
    await openDoc()
    await postComment()
    await postComment()
    await postComment()
    expect(apiMock.postArtifactComment).toHaveBeenCalledTimes(3)
    expect(apiMock.sendChat).not.toHaveBeenCalled() // inside the debounce
    await act(async () => { await vi.advanceTimersByTimeAsync(1600) })
    expect(apiMock.sendChat).toHaveBeenCalledTimes(1)
  })
})

describe('interleaved-edit merge (phase 4)', () => {
  it('409 → clean 3-way merge adopts, banners, and re-saves the merged text', async () => {
    // Disjoint regions: the user edits the 'omega' line (stub-type); the
    // server's copy changed the 'alpha' line.
    const THEIRS = { ...DOC, content: '# doc\n\nalpha line, agent improved.\n\nomega line.\n', content_sha256: 'sha-9' }
    saveDocMock
      .mockRejectedValueOnce(new StaleDocError('stale', 'sha-9'))
      .mockResolvedValue({ contentSha256: 'sha-10' })
    await openDoc()
    apiMock.artifact.mockResolvedValue(THEIRS)
    fireEvent.click(screen.getByText('stub-type'))
    await act(async () => { await vi.advanceTimersByTimeAsync(900) }) // first save → 409 → merge
    expect(screen.getByText(/Merged the co-author/)).toBeInTheDocument()
    const mergedValue = screen.getByTestId('editor-value').textContent ?? ''
    expect(mergedValue).toContain('omega user-edit')
    expect(mergedValue).toContain('alpha line, agent improved.')
    await act(async () => { await vi.advanceTimersByTimeAsync(900) }) // armed retry persists
    const last = saveDocMock.mock.calls.at(-1)
    expect(last?.[1]).toContain('alpha line, agent improved.')
    expect(last?.[1]).toContain('omega user-edit')
    expect(last?.[2]).toMatchObject({ expectedSha256: 'sha-9' })
  })

  it('409 → overlapping edits keep the loud conflict banner, nothing dropped', async () => {
    saveDocMock.mockRejectedValueOnce(new StaleDocError('stale', 'sha-9'))
    await openDoc()
    apiMock.artifact.mockResolvedValue({ ...DOC, content: '# doc\n\nalpha line.\n\nomega agent-version.\n', content_sha256: 'sha-9' })
    fireEvent.click(screen.getByText('stub-type'))
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    expect(screen.getByText(/Changed on the server/)).toBeInTheDocument()
    expect(screen.getByTestId('editor-value').textContent).toContain('omega user-edit') // buffer intact
  })
})

describe('caret-follow and selection', () => {
  const THREADS = [{ id: 't1', body: 'tighten this', status: 'open', anchor: { quote: 'q1' } }]

  it('a caret inside a highlight opens its thread; a range selection closes it so the pill is reachable', async () => {
    apiMock.artifactComments.mockResolvedValue({ comments: THREADS })
    await openDoc()
    fireEvent.click(screen.getByText('stub-caret-in-t1'))
    expect(await screen.findByTestId('inkwell-thread-popover')).toBeInTheDocument()
    // User starts drag-selecting (possibly inside the same highlight): the
    // thread popover must get out of the way — new comments are allowed here.
    fireEvent.click(screen.getByText('stub-range-select'))
    expect(screen.queryByTestId('inkwell-thread-popover')).not.toBeInTheDocument()
    // The pill click then opens the composer at the selection.
    fireEvent.click(screen.getByText('stub-select'))
    expect(screen.getByTestId('inkwell-comment-composer')).toBeInTheDocument()
    expect(screen.queryByTestId('inkwell-thread-popover')).not.toBeInTheDocument()
  })
})

describe('comment composer', () => {
  it('send posts an anchored comment, then a nudge turn, then refetches', async () => {
    apiMock.postArtifactComment.mockResolvedValue({})
    apiMock.createChatSlot.mockResolvedValue({ key: 'chat-9', title: 'Inkwell: notes' })
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
      anchor: { quote: 'a quoted passage', prefix: 'ctx ', suffix: ' more', start_offset: 4, end_offset: 20 },
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(1600) }) // nudge debounce
    expect(apiMock.sendChat).toHaveBeenCalled()
    expect(apiMock.artifactComments.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})
