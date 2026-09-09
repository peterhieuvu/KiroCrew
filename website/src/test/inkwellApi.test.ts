/**
 * Inkwell save layer — the one call that bypasses the shared api client
 * because it needs precise 409 handling for the optimistic-concurrency
 * token (#7818), capability-detected on pre-token gateways.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { saveDoc, StaleDocError } from '../apps/inkwell/api'

function mockFetchOnce(status: number, body: unknown) {
  const res = {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response
  const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(res)
  return spy
}

afterEach(() => vi.restoreAllMocks())

describe('saveDoc', () => {
  it('autosave path: snapshot:false, no token sent when none held (pre-#7818)', async () => {
    const spy = mockFetchOnce(200, { version: 1 })
    const r = await saveDoc('doc', '# x', { expectedSha256: null })
    const [url, init] = spy.mock.calls[0]
    expect(url).toBe('/api/artifacts/doc')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.snapshot).toBe(false)
    expect('expected_sha256' in body).toBe(false)
    expect(r.contentSha256).toBeNull() // capability absent — stays null
  })

  it('carries the token when held, adopts the fresh one from the response', async () => {
    const spy = mockFetchOnce(200, { content_sha256: 'bbb', version: 2 })
    const r = await saveDoc('doc', 'text', { expectedSha256: 'aaa', snapshot: true })
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string)
    expect(body.expected_sha256).toBe('aaa')
    expect(body.snapshot).toBe(true)
    expect(r.contentSha256).toBe('bbb')
  })

  it('409 → StaleDocError carrying the server current hash', async () => {
    mockFetchOnce(409, { error: 'stale write', current_sha256: 'ccc' })
    const err = await saveDoc('doc', 'text', { expectedSha256: 'aaa' }).catch(e => e)
    expect(err).toBeInstanceOf(StaleDocError)
    expect((err as StaleDocError).currentSha256).toBe('ccc')
  })

  it('non-409 failure → plain Error with the server detail', async () => {
    mockFetchOnce(500, { error: 'boom' })
    const err = await saveDoc('doc', 'text').catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(StaleDocError)
    expect((err as Error).message).toBe('boom')
  })
})
