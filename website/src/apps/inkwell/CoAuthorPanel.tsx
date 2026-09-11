/**
 * CoAuthorPanel — the embedded co-author chat for a Inkwell document.
 *
 * Mounts the FULL native ChatPage (`switchSlot()` + `<ChatPage embedded />`),
 * the same approach papyrus's CoAuthorPanel and ArtifactChatPanel take, so the
 * co-author experience is identical to the normal chat page. `embedMode="chat"`
 * selects single-session chrome (no sessions sidebar) and `noUrlSync` keeps
 * ChatPage's deep-link handling off the host route, which InkwellPage owns.
 *
 * Session lifecycle (find-or-create, remember which slot belongs to which
 * document) lives in InkwellPage; this component activates whatever slot it is
 * handed.
 *
 * PROTOTYPE NOTE: user-facing strings are plain English pending i18n catalog
 * entries — a PR blocker, not a prototype blocker.
 */
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, MessageSquarePlus, Sparkles, X } from 'lucide-react'
import { useAppDispatch } from '../../store'
import { switchSlot } from '../../store/chatSlice'
import ChatPage from '../../pages/ChatPage'

export interface CoAuthorPanelProps {
  /** The document's chat slot key, or null when none exists yet. */
  slotKey: string | null
  /** True while a slot create is in flight. */
  creating: boolean
  onStartSession: () => void
  onClose: () => void
}

export default function CoAuthorPanel({
  slotKey,
  creating,
  onStartSession,
  onClose,
}: CoAuthorPanelProps) {
  const dispatch = useAppDispatch()
  const { t } = useTranslation()
  const prevSlotRef = useRef<string | null>(null)

  // Activate the document's session. Re-dispatches when the document changes
  // (a different doc means a different slot) but not on unrelated re-renders.
  useEffect(() => {
    if (slotKey && slotKey !== prevSlotRef.current) {
      prevSlotRef.current = slotKey
      dispatch(switchSlot(slotKey))
    }
  }, [slotKey, dispatch])

  return (
    <aside
      className="flex flex-col h-full min-h-0 border-l border-border bg-card overflow-hidden"
      aria-label={t('apps.inkwell.coAuthor.panel_label')}
      data-testid="inkwell-co-author"
    >
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border shrink-0">
        <Sparkles className="lucide-inline text-accent shrink-0" />
        <span className="flex-1 truncate text-[12px] font-medium text-text">{t('apps.inkwell.coAuthor.title')}</span>
        <button
          type="button"
          onClick={onClose}
          title={t('apps.inkwell.coAuthor.close_title')}
          aria-label={t('apps.inkwell.coAuthor.close_label')}
          className="p-1 rounded text-muted hover:text-danger hover:bg-danger/10 cursor-pointer bg-transparent border-none transition-colors"
        >
          <X className="lucide-inline" />
        </button>
      </div>

      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {slotKey ? (
          <ChatPage embedded embedMode="chat" noUrlSync />
        ) : creating ? (
          <div className="flex-1 flex items-center justify-center gap-2 text-muted text-[13px]" role="status">
            <Loader2 className="lucide-inline animate-spin motion-reduce:animate-none" />
            {t('apps.inkwell.coAuthor.starting_session')}
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 px-4 text-center text-muted text-[13px]">
            <span>{t('apps.inkwell.coAuthor.no_session')}</span>
            <button
              type="button"
              onClick={onStartSession}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-elevated px-3 py-1.5 text-[13px] text-text hover:bg-bg-hover cursor-pointer transition-colors focus-ring"
            >
              <MessageSquarePlus className="lucide-inline" />
              {t('apps.inkwell.coAuthor.start_session')}
            </button>
          </div>
        )}
      </div>
    </aside>
  )
}
