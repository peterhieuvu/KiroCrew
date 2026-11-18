// Inkwell's thin layer over the core artifact API.
//
// The store rework (design doc: "Content management: the artifact store")
// deleted Inkwell's own backend: documents are markdown-kind artifacts tagged
// `inkwell`, read and listed through the main `api` client. The one call kept
// here is the save, because it needs precise 409 handling for the
// artifact store's optimistic-concurrency token, which the generic client
// helpers flatten into a generic Error.
//
// The token is opaque: reads and saves return `content_token`, a guarded
// save echoes it back as `expected_token`, and a stale one is refused with
// 409 `{code: "artifact_conflict", current_token}`. The store serves no token
// for live file-backed artifacts or untokened legacy records; for those we
// send none and saves are last-write-wins, with agent-always-snapshot
// versions as the recovery net.

import type { Artifact } from '../../types'
import { i18nT } from '../../i18n/t'

/** The tag that marks an artifact as an Inkwell document. */
export const INKWELL_TAG = 'inkwell'

/** Thrown when a guarded save is refused (409): another content write
 *  landed since the token we hold was issued. Carries the server's current
 *  token so the caller can re-base without an extra round-trip. */
export class StaleDocError extends Error {
  constructor(
    message: string,
    /** Token of the content now live on the server. */
    readonly currentToken: string | null,
  ) {
    super(message)
  }
}

export interface SaveResult {
  /** Token for the next guarded save; null when the store serves none. */
  contentToken: string | null
  version?: number
}

/** Artifact detail; `content_token` is absent when the store serves none. */
export type InkwellDoc = Artifact

/** Save document content.
 *
 * `snapshot: false` is the autosave path — updates live state with no
 * version bump (the store's "silent saves between snapshots").
 * `snapshot: true` is the explicit checkpoint button.
 */
export async function saveDoc(
  slug: string,
  content: string,
  opts: { expectedToken?: string | null; snapshot?: boolean } = {},
): Promise<SaveResult> {
  const body: Record<string, unknown> = { content, snapshot: !!opts.snapshot }
  if (opts.expectedToken) body.expected_token = opts.expectedToken
  const res = await fetch(`/api/artifacts/${encodeURIComponent(slug)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.status === 409) {
    let currentToken: string | null = null
    let detail = i18nT('apps.inkwell.api.doc_changed_on_server')
    try {
      const j = (await res.json()) as { error?: string; current_token?: string | null }
      currentToken = j.current_token ?? null
      if (j.error) detail = j.error
    } catch { /* body shape is best-effort */ }
    throw new StaleDocError(detail, currentToken)
  }
  if (!res.ok) {
    let detail = ''
    try { detail = ((await res.json()) as { error?: string }).error ?? '' } catch { /* ignore */ }
    throw new Error(detail || `HTTP ${res.status}`)
  }
  const j = (await res.json()) as { content_token?: string | null; version?: number }
  return { contentToken: j.content_token ?? null, version: j.version }
}
