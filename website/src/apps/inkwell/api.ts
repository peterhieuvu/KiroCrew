// Inkwell's thin layer over the core artifact API.
//
// The store rework (design doc: "Content management: the artifact store")
// deleted Inkwell's own backend: documents are markdown-kind artifacts tagged
// `inkwell`, read and listed through the main `api` client. The one call kept
// here is the save, because it needs precise 409 handling for the
// optimistic-concurrency token (#7818) that the generic client helpers
// flatten into a generic Error.
//
// Capability detection, not a hard dependency: on gateways that predate
// #7818, reads carry no `content_sha256` and we send no `expected_sha256` —
// saves are last-write-wins there, with agent-always-snapshot versions as
// the recovery net. The moment the server starts returning hashes, the
// guard engages with no app change.

import type { Artifact } from '../../types'
import { i18nT } from '../../i18n/t'

/** The tag that marks an artifact as a Inkwell document. */
export const INKWELL_TAG = 'inkwell'

/** Thrown when a guarded save is refused (409): live content no longer
 *  hashes to the token we read. Carries the server's current hash so the
 *  caller can re-base without an extra round-trip. */
export class StaleDocError extends Error {
  constructor(
    message: string,
    /** Hash of the content now live on the server. */
    readonly currentSha256: string | null,
  ) {
    super(message)
  }
}

export interface SaveResult {
  /** Token for the next guarded save; null on pre-#7818 gateways. */
  contentSha256: string | null
  version?: number
}

/** Artifact detail plus the concurrency token (absent pre-#7818). */
export type InkwellDoc = Artifact & { content_sha256?: string | null }

/** Save document content.
 *
 * `snapshot: false` is the autosave path — updates live state with no
 * version bump (the store's "silent saves between snapshots").
 * `snapshot: true` is the explicit checkpoint button.
 */
export async function saveDoc(
  slug: string,
  content: string,
  opts: { expectedSha256?: string | null; snapshot?: boolean } = {},
): Promise<SaveResult> {
  const body: Record<string, unknown> = { content, snapshot: !!opts.snapshot }
  if (opts.expectedSha256) body.expected_sha256 = opts.expectedSha256
  const res = await fetch(`/api/artifacts/${encodeURIComponent(slug)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.status === 409) {
    let currentSha: string | null = null
    let detail = i18nT('apps.inkwell.api.doc_changed_on_server')
    try {
      const j = (await res.json()) as { error?: string; current_sha256?: string }
      currentSha = j.current_sha256 ?? null
      if (j.error) detail = j.error
    } catch { /* body shape is best-effort */ }
    throw new StaleDocError(detail, currentSha)
  }
  if (!res.ok) {
    let detail = ''
    try { detail = ((await res.json()) as { error?: string }).error ?? '' } catch { /* ignore */ }
    throw new Error(detail || `HTTP ${res.status}`)
  }
  const j = (await res.json()) as { content_sha256?: string | null; version?: number }
  return { contentSha256: j.content_sha256 ?? null, version: j.version }
}
