/**
 * Context rail (RFC phase 5): synchronous memory + knowledge cards beside the
 * document — the "what did we decide about X" half of the design, answered
 * with NO agent turn (no latency, no tokens).
 *
 * Two sources, both plain HTTP reads the app declares in `permissions.api`:
 *  - `GET /api/knowledge/search-for-context?q=` — hybrid retrieval, returns
 *    citation-ready cards.
 *  - `GET /api/memory/semantic` — the full semantic store (paginated, ≤1000);
 *    filtered client-side by the same query terms. There is no server-side
 *    memory search, and the dashboard's own memory card takes the same
 *    approach, so this matches platform practice rather than inventing one.
 *
 * The query is derived from the document: the current heading path (the H1
 * plus the heading nearest the caret) and the selection when there is one.
 * Fetches are debounced and stale responses are dropped by request id.
 */
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BookOpen, Brain, RefreshCw } from 'lucide-react'
import { api } from '../../api/client'
import type { CaretHeadings } from './headings'

const RAIL_DEBOUNCE_MS = 600
const MAX_KNOWLEDGE = 5
const MAX_MEMORY = 5

/** Terms worth searching on: words ≥4 chars, minus the usual noise. */
const STOP = new Set(['this', 'that', 'with', 'from', 'have', 'will', 'been', 'were', 'they', 'their', 'about', 'which', 'when', 'what', 'into', 'than', 'then', 'also', 'more', 'some', 'such', 'only', 'over', 'your', 'should', 'would', 'could'])

export function extractQueryTerms(text: string, max = 8): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.toLowerCase().split(/[^a-z0-9_-]+/)) {
    if (raw.length < 4 || STOP.has(raw) || seen.has(raw)) continue
    seen.add(raw)
    out.push(raw)
    if (out.length >= max) break
  }
  return out
}

/** The document's current subject: H1 + the nearest heading above the
 *  caret line, or the whole first 400 chars when there are no headings. */
export function deriveQuery(markdown: string, caret: CaretHeadings | null, selection: string | null): string {
  if (selection && selection.trim().length >= 8) return selection.trim().slice(0, 300)
  // Headings come from the editor's document model (see headings.ts), never
  // from re-parsing markdown text: line counting desynced on multi-line blocks.
  const h1 = caret?.h1 ?? null
  const nearest = caret?.nearest ?? null
  if (!h1 && !nearest) return markdown.slice(0, 400)
  const top = h1 ?? nearest!
  return nearest && nearest !== top ? `${top} ${nearest}` : top
}

interface KnowledgeCard {
  id: string
  title: string
  summary?: string
  source_name?: string | null
  match_type?: string
}
interface MemoryEntry {
  key: string
  value: string
}

/** Rank semantic entries by how many query terms hit key or value. */
export function rankMemory(entries: MemoryEntry[], terms: string[], max = MAX_MEMORY): MemoryEntry[] {
  if (terms.length === 0) return []
  return entries
    .map(e => {
      const hay = `${e.key} ${e.value}`.toLowerCase()
      const score = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0)
      return { e, score }
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(x => x.e)
}

interface Props {
  markdown: string
  caret: CaretHeadings | null
  selection: string | null
  onClose: () => void
}

export default function ContextRail({ markdown, caret, selection, onClose }: Props) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [knowledge, setKnowledge] = useState<KnowledgeCard[]>([])
  const [memory, setMemory] = useState<MemoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const reqRef = useRef(0)
  // The semantic store is fetched once per rail mount and filtered locally.
  const memoryCacheRef = useRef<MemoryEntry[] | null>(null)

  useEffect(() => {
    const q = deriveQuery(markdown, caret, selection)
    const timer = setTimeout(() => {
      if (!q.trim()) return
      setQuery(q)
      const id = ++reqRef.current
      setLoading(true)
      const terms = extractQueryTerms(q)
      void (async () => {
        try {
          const [k, m] = await Promise.all([
            api.knowledgeSearch(q).catch(() => null) as Promise<{ results?: KnowledgeCard[] } | null>,
            memoryCacheRef.current
              ? Promise.resolve(memoryCacheRef.current)
              : (api.vectorSemantic() as Promise<{ entries?: MemoryEntry[] }>)
                .then(r => { memoryCacheRef.current = r.entries ?? []; return memoryCacheRef.current })
                .catch(() => null),
          ])
          if (id !== reqRef.current) return // stale
          if (!k && !m) { setUnavailable(t('apps.inkwell.contextRail.sources_unavailable')); return }
          setUnavailable(null)
          setKnowledge((k?.results ?? []).slice(0, MAX_KNOWLEDGE))
          setMemory(rankMemory(m ?? [], terms))
        } finally {
          if (id === reqRef.current) setLoading(false)
        }
      })()
    }, RAIL_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [markdown, caret?.h1, caret?.nearest, selection]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <aside className="w-[300px] shrink-0 border-l border-border bg-card flex flex-col min-h-0" aria-label={t('apps.inkwell.contextRail.rail_label')} data-testid="inkwell-context-rail">
      <div className="flex items-center gap-1.5 px-3 py-2 border-b border-border shrink-0">
        <BookOpen className="lucide-inline text-accent" />
        <span className="flex-1 text-[13px] font-semibold text-text">{t('apps.inkwell.contextRail.title')}</span>
        {loading && <RefreshCw className="lucide-inline text-muted animate-spin" aria-label={t('apps.inkwell.contextRail.loading')} />}
        <button
          type="button"
          onClick={onClose}
          aria-label={t('apps.inkwell.contextRail.close_label')}
          className="p-1 rounded text-muted hover:text-text hover:bg-bg-hover cursor-pointer bg-transparent border-none transition-colors"
        >
          ×
        </button>
      </div>
      <div className="px-3 py-1.5 text-[11px] text-muted truncate border-b border-border/50" title={query}>
        {query ? t('apps.inkwell.contextRail.searching', { query }) : t('apps.inkwell.contextRail.search_hint')}
      </div>
      <div className="flex-1 overflow-y-auto">
        {unavailable && <div className="px-3 py-2 text-[12px] text-danger">{unavailable}</div>}
        <section className="px-3 pt-2">
          <h3 className="text-[11px] uppercase tracking-wide text-muted flex items-center gap-1"><BookOpen className="lucide-inline" /> {t('apps.inkwell.contextRail.knowledge')}</h3>
          {knowledge.length === 0 && !loading && <div className="py-1 text-[12px] text-muted">{t('apps.inkwell.contextRail.no_knowledge')}</div>}
          {knowledge.map(c => (
            <div key={c.id} className="py-1.5 border-b border-border/40 last:border-b-0">
              <div className="text-[12px] text-text font-medium truncate" title={c.title}>{c.title}</div>
              {c.summary && <div className="text-[11px] text-muted line-clamp-3">{c.summary}</div>}
              {c.source_name && <div className="text-[10px] text-muted/80 truncate">{c.source_name}</div>}
            </div>
          ))}
        </section>
        <section className="px-3 pt-3 pb-2">
          <h3 className="text-[11px] uppercase tracking-wide text-muted flex items-center gap-1"><Brain className="lucide-inline" /> {t('apps.inkwell.contextRail.memory')}</h3>
          {memory.length === 0 && !loading && <div className="py-1 text-[12px] text-muted">{t('apps.inkwell.contextRail.no_memory')}</div>}
          {memory.map(e => (
            <div key={e.key} className="py-1.5 border-b border-border/40 last:border-b-0">
              <div className="text-[11px] text-accent font-mono truncate" title={e.key}>{e.key}</div>
              <div className="text-[11px] text-text line-clamp-4">{e.value}</div>
            </div>
          ))}
        </section>
      </div>
    </aside>
  )
}
