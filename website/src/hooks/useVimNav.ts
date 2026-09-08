/**
 * useVimNav — the vim-style navigation loop, mounted once at the App root.
 *
 * DOM focus is the mode (see `lib/vimNav.ts`), so this hook owns only the two
 * transitions and the normal-mode accelerators:
 *
 *  - **Exit insert** (`Esc` / `Ctrl+[` while the composer holds focus): blur
 *    the composer and hand focus to the transcript scroller, which already
 *    carries `tabIndex={-1}` for exactly this kind of programmatic handoff.
 *  - **Normal-mode dispatch** (bare keys anywhere non-editable): `j`/`k`
 *    switch sessions in DISPLAYED sidebar order, `i`/`a` re-enter the
 *    composer, `/` opens quick search.
 *
 * `j`/`k` act on the STORE, not the DOM — the same `switchSlot` +
 * `orderSlotsBySidebar` machinery the Ctrl+digit jumps use — so the sidebar
 * needs no focus model and needn't even be visible. One deliberate departure
 * from `kbSwitch`: the one-shot composer release is armed on EVERY platform,
 * not just macOS. The digit chords release only on Mac because elsewhere they
 * still fire while focus sits in an input; a bare `j` never does, so without
 * the release every switch's composer autofocus would put the very next `j`
 * behind the editable-target guard — normal mode would self-terminate after
 * one keypress on every platform.
 *
 * Escape yields the way the composer's own dictation handler documents
 * (ChatInput ~L1411): BUBBLE phase so an open picker's capture-phase handler
 * wins outright, then `isComposing`, `defaultPrevented`, and a
 * `[role="dialog"]` probe that defers to every dialog without enumerating
 * them. `stopPropagation()` only once the key is claimed — downstream window
 * handlers do not check `defaultPrevented`.
 */
import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { useAppDispatch, useAppStore } from '../store'
import { switchSlot } from '../store/chatSlice'
import { orderSlotsBySidebar, wrapIndex, SHORTCUTS_ENABLED_KEY, SHORTCUTS_ENABLED_EVENT } from './useKeyboardShortcuts'
import { queryComposerOrExpand, releaseComposerForKeyboardSwitch } from '../pages/chat/composerFocus'
import {
  getVimNavEnabled,
  isEditableTarget,
  isExitInsertKey,
  matchVimNormalKey,
  VIM_NAV_EVENT,
} from '../lib/vimNav'

/** Live read of the global shortcuts toggle (default on; '0' means disabled). */
const shortcutsEnabled = () => localStorage.getItem(SHORTCUTS_ENABLED_KEY) !== '0'

/** Both gates at once: the vim opt-in AND the global shortcuts master toggle. */
const vimActive = () => getVimNavEnabled() && shortcutsEnabled()

/**
 * The composer textarea currently holding focus, or null. Excludes the side
 * chat's composer for the reason `queryComposer` documents: it is a separate
 * conversation that happens to mount the same component, and nothing in this
 * module is ever aimed at it.
 */
function focusedComposer(): HTMLTextAreaElement | null {
  const ae = document.activeElement
  if (!(ae instanceof HTMLTextAreaElement)) return null
  if (!ae.hasAttribute('data-composer-input')) return null
  if (ae.closest('[data-side-chat-input]')) return null
  return ae
}

/**
 * Where focus lands when leaving insert mode: the transcript scroller
 * (`.chat-container`, the stable theming hook, already `tabIndex={-1}`).
 * Keeps a real `document.activeElement` — no dead body-focus state — and makes
 * the browser's native PgUp/PgDn/Space scrolling work on the conversation as a
 * free consequence. Falls back to a plain blur when no transcript is mounted
 * (e.g. a settings route), which still leaves insert mode.
 */
function focusRestingTarget(): void {
  const scroller = document.querySelector<HTMLElement>('.chat-container')
  scroller?.focus({ preventScroll: true })
}

export interface UseVimNavOptions {
  /** Opens the quick-search surface (the Command Bar / palette open path). */
  openQuickSearch: () => void
}

/**
 * Returns whether vim navigation is currently enabled, so the host can render
 * the normal-mode indicator without a second subscription.
 */
export function useVimNav({ openQuickSearch }: UseVimNavOptions): { vimNavEnabled: boolean } {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const appStore = useAppStore()
  const [enabled, setEnabled] = useState(vimActive)

  // Preference changes arrive as window events (same pattern as the shortcut
  // toggles) so an open Settings page flips behavior live, no remount needed.
  useEffect(() => {
    const update = () => setEnabled(vimActive())
    window.addEventListener(VIM_NAV_EVENT, update)
    window.addEventListener(SHORTCUTS_ENABLED_EVENT, update)
    return () => {
      window.removeEventListener(VIM_NAV_EVENT, update)
      window.removeEventListener(SHORTCUTS_ENABLED_EVENT, update)
    }
  }, [])

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Read the gates LIVE, not from state: a keydown can race the event that
    // syncs `enabled`, and the storage read is what the sibling hooks trust.
    if (!vimActive()) return
    if (e.isComposing || e.defaultPrevented) return

    // ---- Exit insert: Esc / Ctrl+[ while the composer holds focus ----------
    const composer = focusedComposer()
    if (composer) {
      if (!isExitInsertKey(e)) return
      // Escape belongs to the TOPMOST dismissible surface. Pickers that consume
      // it never reach this bubble-phase handler; dialogs are deferred to by
      // presence. (First Esc dismisses, second exits insert — layering for free.)
      if (document.querySelector('[role="dialog"]')) return
      e.preventDefault()
      e.stopPropagation()
      composer.blur()
      focusRestingTarget()
      return
    }

    // ---- Normal mode: bare-key accelerators --------------------------------
    if (isEditableTarget(e.target)) return
    if (document.querySelector('[role="dialog"]')) return
    const action = matchVimNormalKey(e)
    if (!action) return

    if (action === 'insert') {
      e.preventDefault()
      // Deliberately not `focusComposer`: a pressed key proves a keyboard
      // exists, so the touch-device guard must not suppress this (same
      // rationale as Alt+Enter's direct call).
      queryComposerOrExpand(ta => ta.focus())
      return
    }

    if (action === 'search') {
      e.preventDefault()
      openQuickSearch()
      return
    }

    // next-session / prev-session
    const { dashboard: { slots, sidebarOrder }, chat: { activeSlot } } = appStore.getState()
    const ordered = orderSlotsBySidebar(slots, sidebarOrder)
    if (ordered.length === 0) return
    e.preventDefault()
    const curIdx = activeSlot ? ordered.findIndex(s => s.key === activeSlot) : -1
    const nextIdx = wrapIndex(ordered.length, curIdx, action === 'next-session' ? 1 : -1)
    if (nextIdx < 0) return
    const target = ordered[nextIdx].key
    // Release on every platform, and only on a real change (a same-key wrap
    // produces no autoFocusKey transition to consume the one-shot).
    if (target !== activeSlot) releaseComposerForKeyboardSwitch()
    dispatch(switchSlot(target))
    navigate('/chat')
  }, [appStore, dispatch, navigate, openQuickSearch])

  useEffect(() => {
    // BUBBLE phase on document: every focused surface, picker, and dialog gets
    // first refusal on its own keys; this handler only ever takes leftovers.
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  return { vimNavEnabled: enabled }
}
