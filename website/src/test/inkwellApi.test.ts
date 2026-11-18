/**
 * Inkwell save layer — the one call that bypasses the shared api client
 * because it needs precise 409 handling for the optimistic-concurrency
 * token, which the store omits for file-backed and legacy records.
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
  it('autosave path: snapshot:false, no token sent when none held (store served none)', async () => {
    const spy = mockFetchOnce(200, { version: 1 })
    const r = await saveDoc('doc', '# x', { expectedToken: null })
    const [url, init] = spy.mock.calls[0]
    expect(url).toBe('/api/artifacts/doc')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.snapshot).toBe(false)
    expect('expected_token' in body).toBe(false)
    expect(r.contentToken).toBeNull() // no token served — stays null
  })

  it('carries the token when held, adopts the fresh one from the response', async () => {
    const spy = mockFetchOnce(200, { content_token: 'bbb', version: 2 })
    const r = await saveDoc('doc', 'text', { expectedToken: 'aaa', snapshot: true })
    const body = JSON.parse((spy.mock.calls[0][1] as RequestInit).body as string)
    expect(body.expected_token).toBe('aaa')
    expect(body.snapshot).toBe(true)
    expect(r.contentToken).toBe('bbb')
  })

  it('409 → StaleDocError carrying the server current token', async () => {
    mockFetchOnce(409, { error: 'stale write', code: 'artifact_conflict', current_token: 'ccc' })
    const err = await saveDoc('doc', 'text', { expectedToken: 'aaa' }).catch(e => e)
    expect(err).toBeInstanceOf(StaleDocError)
    expect((err as StaleDocError).currentToken).toBe('ccc')
  })

  it('non-409 failure → plain Error with the server detail', async () => {
    mockFetchOnce(500, { error: 'boom' })
    const err = await saveDoc('doc', 'text').catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(StaleDocError)
    expect((err as Error).message).toBe('boom')
  })
})
