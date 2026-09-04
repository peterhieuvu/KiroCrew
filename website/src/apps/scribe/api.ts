// Thin fetch wrapper for the Scribe backend.
//
// Routes are registered directly on the main gateway's aiohttp Application
// (kiro_crew/apps/builtins/scribe/backend/routes.py:register_routes), so the
// base path is /api/apps/scribe — the papyrus/issue-radar shape, NOT the
// /apps/{name}/api reverse-proxy prefix used by child-process apps.
//
// This is a BUILTIN dashboard page rendered inside the main React tree, so
// every request is a same-origin fetch carrying the dashboard's session cookie.

const API = '/api/apps/scribe'

export interface DocSummary {
  name: string
  /** Epoch milliseconds. */
  mtime: number
}

export interface DocDetail {
  name: string
  /** Absolute path on disk — handed to the co-author in its context note. */
  path: string
  content: string
  mtime: number
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { error?: string; code?: string }
      detail = body.error ?? ''
      if (body.code === 'stale') throw new StaleDocError(detail)
    } catch (e) {
      if (e instanceof StaleDocError) throw e
    }
    throw new Error(detail || `HTTP ${res.status}`)
  }
  return (await res.json()) as T
}

/** Thrown when a save is refused because the file moved on disk (409 stale). */
export class StaleDocError extends Error {}

export const scribeApi = {
  listDocs: () => req<{ docs: DocSummary[] }>('/docs'),
  createDoc: (name: string) =>
    req<{ name: string; path: string; mtime: number }>('/docs', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  readDoc: (name: string) => req<DocDetail>(`/doc?name=${encodeURIComponent(name)}`),
  saveDoc: (name: string, content: string, baseMtime: number) =>
    req<{ mtime: number }>('/doc', {
      method: 'PUT',
      body: JSON.stringify({ name, content, baseMtime }),
    }),
  getSlot: (name: string) => req<{ slot: string | null }>(`/slot?name=${encodeURIComponent(name)}`),
  putSlot: (name: string, slot: string) =>
    req<{ ok: boolean }>('/slot', {
      method: 'PUT',
      body: JSON.stringify({ name, slot }),
    }),
}

// --- co-author slot persistence ---------------------------------------------
//
// The doc->slot mapping is SERVER-side (scribe's own backend, one JSON file in
// the app data dir) so a document reopened from any browser or a fresh profile
// reattaches to its existing co-author session. localStorage is kept only as a
// write-through fallback for a backend that predates the /slot routes.

const SLOT_KEY_PREFIX = 'kc:scribe:slot:'

/** Remembered co-author slot for a document, or null. Never throws. */
export async function loadSlot(doc: string): Promise<string | null> {
  try {
    const { slot } = await scribeApi.getSlot(doc)
    if (slot) return slot
  } catch {
    /* backend without /slot routes — fall back below */
  }
  try {
    return localStorage.getItem(SLOT_KEY_PREFIX + doc)
  } catch {
    return null
  }
}

/** Remember a document's co-author chat slot (never throws). */
export function saveSlot(doc: string, slot: string): void {
  scribeApi.putSlot(doc, slot).catch(() => undefined)
  try {
    localStorage.setItem(SLOT_KEY_PREFIX + doc, slot)
  } catch {
    /* storage blocked or full — the server mapping still holds */
  }
}
