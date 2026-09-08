/**
 * Vim-style navigation — the pure layer: preference storage, the binding
 * table, and the keydown matchers.
 *
 * The design premise (and the reason this file is small): **DOM focus is the
 * mode.** Composer focused = insert mode; anything else = normal mode. There
 * is no mode state machine anywhere — only transitions (Esc / Ctrl+[ leaves
 * the composer, `i` returns to it) and bare-key accelerators that act on the
 * store rather than the DOM, so no surface has to give up ownership of its own
 * keys. The matchers here are pure so the guard logic is unit-testable
 * without React or a store.
 *
 * Deliberately absent, so they cannot creep in one binding at a time:
 * multi-key sequences (`gg`) and count prefixes (`3j`). Both need pending-key
 * state and prefix-aware conflict detection — modal machinery this feature is
 * built to avoid. The table is single-keystroke only.
 *
 * Preference is a per-browser localStorage flag (default OFF), read through
 * guarded accessors like every sibling preference in this directory: a
 * privacy mode that throws on read degrades to "disabled", never a crash.
 */
import { safeSetItem } from '../utils/safeStorage'

/** localStorage key for the vim-navigation opt-in. '1' = enabled; default off. */
export const VIM_NAV_KEY = 'mc-vim-nav'
/** Window event fired after the preference changes, for live re-reads. */
export const VIM_NAV_EVENT = 'mc-vim-nav-changed'

/** Live read of the vim-navigation opt-in. Default OFF — this is an opt-in. */
export function getVimNavEnabled(): boolean {
  try {
    return localStorage.getItem(VIM_NAV_KEY) === '1'
  } catch {
    return false
  }
}

export function setVimNavEnabled(v: boolean): void {
  safeSetItem(VIM_NAV_KEY, v ? '1' : '0')
  window.dispatchEvent(new Event(VIM_NAV_EVENT))
}

/**
 * True when a keydown target is an editable surface that owns its own keys.
 *
 * This single predicate is what makes bare-key accelerators safe to dispatch
 * from a document listener: typing surfaces never see them. It intentionally
 * covers the terminal too — xterm focuses a hidden helper `<textarea>`, so the
 * PTY is excluded by construction rather than by a special case.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable
}

/** The normal-mode actions the dispatcher can resolve a keydown to. */
export type VimNavAction =
  /** Switch to the next session in displayed sidebar order. */
  | 'next-session'
  /** Switch to the previous session in displayed sidebar order. */
  | 'prev-session'
  /** Enter insert mode: focus the composer. */
  | 'insert'
  /** Open the quick-search surface. */
  | 'search'

/**
 * One row of the binding table — display metadata for the Settings panel.
 * `caps` are the keycap glyphs the panel renders (alternatives are separate
 * entries in the outer array, rendered as "or"-joined cap sequences).
 */
export interface VimBindingRow {
  id: string
  /** Keycap alternatives, each alternative being a cap sequence. */
  caps: string[][]
  /** i18n catalog key for the row label. */
  labelKey: string
}

/**
 * The v1 binding table. Data, not code: the Settings panel renders it and the
 * dispatcher agrees with it by test, so the reference cannot drift from the
 * behavior the way the legacy palette's hand-written help rows could.
 */
export const VIM_BINDINGS: readonly VimBindingRow[] = [
  { id: 'vim-exit-insert', caps: [['Esc'], ['Ctrl', '[']], labelKey: 'pages.settings.shortcutsPanel.vim_exit_insert' },
  { id: 'vim-insert', caps: [['I'], ['A']], labelKey: 'pages.settings.shortcutsPanel.vim_focus_composer' },
  { id: 'vim-next-session', caps: [['J']], labelKey: 'pages.settings.shortcutsPanel.vim_next_session' },
  { id: 'vim-prev-session', caps: [['K']], labelKey: 'pages.settings.shortcutsPanel.vim_prev_session' },
  { id: 'vim-search', caps: [['/']], labelKey: 'pages.settings.shortcutsPanel.vim_open_search' },
]

/** The subset of KeyboardEvent the matchers read — keeps tests dependency-free. */
export interface VimKeyEventLike {
  key: string
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

/**
 * Resolve a normal-mode keydown to an action, or null when unclaimed.
 *
 * Bare keys ONLY: any modifier (including Shift) releases the event, so
 * existing chords — and characters that need Shift on some layouts — are never
 * shadowed. The one deliberate exception is `/`, matched by `e.key` value
 * rather than physical code, because on several layouts (e.g. German) the
 * slash itself requires Shift; `key === '/'` is layout-resolved, so the check
 * only rejects the chord modifiers, not Shift.
 *
 * Caller is responsible for context guards (editable target, dialogs,
 * composition) — this function answers only "which action does this key name".
 */
export function matchVimNormalKey(e: VimKeyEventLike): VimNavAction | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null
  if (e.key === '/') return 'search'
  if (e.shiftKey) return null
  switch (e.key) {
    case 'j': return 'next-session'
    case 'k': return 'prev-session'
    case 'i':
    case 'a': return 'insert'
    default: return null
  }
}

/**
 * True when a keydown names the exit-insert gesture: bare `Escape`, or
 * `Ctrl+[` — vim's own synonym for Escape, and the binding that works in a
 * fullscreen browser, where Esc is claimed by the user agent for the
 * fullscreen exit and no page handler can suppress that.
 */
export function isExitInsertKey(e: VimKeyEventLike): boolean {
  if (e.key === 'Escape') return !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey
  if (e.key === '[') return e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey
  return false
}
