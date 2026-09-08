import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, render, screen, act } from '@testing-library/react'

import { useVimNav } from '../hooks/useVimNav'
import VimNavIndicator from '../components/VimNavIndicator'
import {
  VIM_NAV_KEY,
  VIM_BINDINGS,
  getVimNavEnabled,
  setVimNavEnabled,
  isEditableTarget,
  isExitInsertKey,
  matchVimNormalKey,
} from '../lib/vimNav'
import { SHORTCUTS_ENABLED_KEY } from '../hooks/useKeyboardShortcuts'
import { consumeComposerRelease } from '../pages/chat/composerFocus'
import { renderHookWithProviders, createTestStore } from './helpers'
import type { RootState } from '../store'

beforeEach(() => localStorage.clear())
afterEach(() => { document.body.innerHTML = '' })

const key = (k: string, mods: Partial<{ ctrl: boolean; alt: boolean; meta: boolean; shift: boolean }> = {}) => ({
  key: k, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, metaKey: !!mods.meta, shiftKey: !!mods.shift,
})

describe('vimNav pure layer', () => {
  it('binding table has unique ids', () => {
    const ids = VIM_BINDINGS.map(b => b.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('matchVimNormalKey resolves the v1 table and nothing else', () => {
    expect(matchVimNormalKey(key('j'))).toBe('next-session')
    expect(matchVimNormalKey(key('k'))).toBe('prev-session')
    expect(matchVimNormalKey(key('i'))).toBe('insert')
    expect(matchVimNormalKey(key('a'))).toBe('insert')
    expect(matchVimNormalKey(key('/'))).toBe('search')
    expect(matchVimNormalKey(key('g'))).toBeNull()
    expect(matchVimNormalKey(key('Escape'))).toBeNull()
  })

  it('matchVimNormalKey releases every chord modifier', () => {
    expect(matchVimNormalKey(key('j', { ctrl: true }))).toBeNull()
    expect(matchVimNormalKey(key('j', { alt: true }))).toBeNull()
    expect(matchVimNormalKey(key('j', { meta: true }))).toBeNull()
    expect(matchVimNormalKey(key('j', { shift: true }))).toBeNull()
    // `/` may legitimately need Shift on some layouts — key value is
    // layout-resolved, so only the chord modifiers release it.
    expect(matchVimNormalKey(key('/', { shift: true }))).toBe('search')
    expect(matchVimNormalKey(key('/', { ctrl: true }))).toBeNull()
  })

  it('isExitInsertKey accepts bare Escape and Ctrl+[ only', () => {
    expect(isExitInsertKey(key('Escape'))).toBe(true)
    expect(isExitInsertKey(key('[', { ctrl: true }))).toBe(true)
    expect(isExitInsertKey(key('Escape', { shift: true }))).toBe(false)
    expect(isExitInsertKey(key('Escape', { ctrl: true }))).toBe(false)
    expect(isExitInsertKey(key('[', { ctrl: true, shift: true }))).toBe(false)
    expect(isExitInsertKey(key('['))).toBe(false)
  })

  it('isEditableTarget covers inputs, textareas, selects, contenteditable', () => {
    const ta = document.createElement('textarea')
    const input = document.createElement('input')
    const sel = document.createElement('select')
    const div = document.createElement('div')
    const ce = document.createElement('div')
    Object.defineProperty(ce, 'isContentEditable', { value: true })
    expect(isEditableTarget(ta)).toBe(true)
    expect(isEditableTarget(input)).toBe(true)
    expect(isEditableTarget(sel)).toBe(true)
    expect(isEditableTarget(div)).toBe(false)
    expect(isEditableTarget(ce)).toBe(true)
    expect(isEditableTarget(null)).toBe(false)
    expect(isEditableTarget(document)).toBe(false)
  })

  it('preference defaults OFF and round-trips through the setter', () => {
    expect(getVimNavEnabled()).toBe(false)
    setVimNavEnabled(true)
    expect(getVimNavEnabled()).toBe(true)
    expect(localStorage.getItem(VIM_NAV_KEY)).toBe('1')
    setVimNavEnabled(false)
    expect(getVimNavEnabled()).toBe(false)
  })
})

describe('useVimNav', () => {
  const openQuickSearch = vi.fn()

  function setup(opts: { vim?: boolean; active?: string | null; slots?: string[] } = {}) {
    if (opts.vim !== false) localStorage.setItem(VIM_NAV_KEY, '1')
    const slotKeys = opts.slots ?? ['slot-1', 'slot-2', 'slot-3']
    // The switchSlot thunk's pending reducer touches most of the chat slice, so
    // preload from the slice's real initial state rather than a partial cast
    // (same pattern as the session-cycling suite in useKeyboardShortcuts.test).
    const chatState = {
      ...createTestStore().getState().chat,
      activeSlot: opts.active === undefined ? 'slot-1' : opts.active,
      slotHistory: [],
    } as RootState['chat']
    const store = createTestStore({
      dashboard: {
        slots: slotKeys.map(k => ({ key: k, title: k, messages: 1, running: false })),
        sidebarOrder: slotKeys,
      } as unknown as RootState['dashboard'],
      chat: chatState,
    })
    renderHookWithProviders(() => useVimNav({ openQuickSearch }), { store })
    return store
  }

  /** A composer textarea in the document, focused, as insert mode has it. */
  function mountComposer(): HTMLTextAreaElement {
    const ta = document.createElement('textarea')
    ta.setAttribute('data-composer-input', '')
    document.body.appendChild(ta)
    ta.focus()
    return ta
  }

  beforeEach(() => { openQuickSearch.mockClear(); consumeComposerRelease() })

  it('does nothing while the opt-in is off (the default)', () => {
    const store = setup({ vim: false })
    fireEvent.keyDown(document.body, { key: 'j' })
    expect(store.getState().chat.activeSlot).toBe('slot-1')
  })

  it('honours the global shortcuts master toggle', () => {
    localStorage.setItem(SHORTCUTS_ENABLED_KEY, '0')
    const store = setup()
    fireEvent.keyDown(document.body, { key: 'j' })
    expect(store.getState().chat.activeSlot).toBe('slot-1')
  })

  it('j/k walk the displayed sidebar order and wrap', () => {
    const store = setup()
    fireEvent.keyDown(document.body, { key: 'j' })
    expect(store.getState().chat.activeSlot).toBe('slot-2')
    fireEvent.keyDown(document.body, { key: 'k' })
    expect(store.getState().chat.activeSlot).toBe('slot-1')
    fireEvent.keyDown(document.body, { key: 'k' })
    expect(store.getState().chat.activeSlot).toBe('slot-3')
  })

  it('a session switch arms the one-shot composer release on every platform', () => {
    setup()
    fireEvent.keyDown(document.body, { key: 'j' })
    expect(consumeComposerRelease()).toBe(true)
  })

  it('bare keys never fire from an editable target', () => {
    const store = setup()
    const input = document.createElement('input')
    document.body.appendChild(input)
    input.focus()
    fireEvent.keyDown(input, { key: 'j' })
    expect(store.getState().chat.activeSlot).toBe('slot-1')
  })

  it('bare keys never fire while a dialog is up', () => {
    const store = setup()
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    document.body.appendChild(dialog)
    fireEvent.keyDown(document.body, { key: 'j' })
    expect(store.getState().chat.activeSlot).toBe('slot-1')
  })

  it('yields to a handler that already claimed the key', () => {
    const store = setup()
    const claim = (e: KeyboardEvent) => e.preventDefault()
    document.addEventListener('keydown', claim, { capture: true })
    fireEvent.keyDown(document.body, { key: 'j' })
    document.removeEventListener('keydown', claim, { capture: true })
    expect(store.getState().chat.activeSlot).toBe('slot-1')
  })

  it('/ opens quick search', () => {
    setup()
    fireEvent.keyDown(document.body, { key: '/' })
    expect(openQuickSearch).toHaveBeenCalledTimes(1)
  })

  it('i focuses the composer', () => {
    setup()
    const ta = document.createElement('textarea')
    ta.setAttribute('data-composer-input', '')
    document.body.appendChild(ta)
    fireEvent.keyDown(document.body, { key: 'i' })
    expect(document.activeElement).toBe(ta)
  })

  describe('exit insert', () => {
    it.each([
      ['Escape', { key: 'Escape' }],
      ['Ctrl+[', { key: '[', ctrlKey: true }],
    ])('%s blurs the composer and consumes the key', (_name, ev) => {
      setup()
      const ta = mountComposer()
      const scroller = document.createElement('div')
      scroller.className = 'chat-container'
      scroller.tabIndex = -1
      document.body.appendChild(scroller)
      const event = new KeyboardEvent('keydown', { ...ev, cancelable: true, bubbles: true })
      act(() => { ta.dispatchEvent(event) })
      expect(event.defaultPrevented).toBe(true)
      expect(document.activeElement).toBe(scroller)
    })

    it('yields when a topmost dialog is up', () => {
      setup()
      const ta = mountComposer()
      const dialog = document.createElement('div')
      dialog.setAttribute('role', 'dialog')
      document.body.appendChild(dialog)
      const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true })
      act(() => { ta.dispatchEvent(event) })
      expect(event.defaultPrevented).toBe(false)
      expect(document.activeElement).toBe(ta)
    })

    it('yields when the key was already claimed (an open picker)', () => {
      setup()
      const ta = mountComposer()
      const claim = (e: KeyboardEvent) => e.preventDefault()
      document.addEventListener('keydown', claim, { capture: true })
      const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true })
      act(() => { ta.dispatchEvent(event) })
      document.removeEventListener('keydown', claim, { capture: true })
      expect(document.activeElement).toBe(ta)
    })

    it('a modified Escape is not the gesture', () => {
      setup()
      const ta = mountComposer()
      const event = new KeyboardEvent('keydown', { key: 'Escape', shiftKey: true, cancelable: true, bubbles: true })
      act(() => { ta.dispatchEvent(event) })
      expect(event.defaultPrevented).toBe(false)
      expect(document.activeElement).toBe(ta)
    })

    it('still leaves insert mode when no transcript is mounted', () => {
      setup()
      const ta = mountComposer()
      const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true })
      act(() => { ta.dispatchEvent(event) })
      expect(event.defaultPrevented).toBe(true)
      expect(document.activeElement).not.toBe(ta)
    })
  })
})

describe('VimNavIndicator', () => {
  it('renders nothing while disabled', () => {
    render(<VimNavIndicator enabled={false} />)
    expect(screen.queryByTestId('vim-nav-indicator')).toBeNull()
  })

  it('shows in normal mode and hides when an editable surface takes focus', () => {
    render(<VimNavIndicator enabled />)
    expect(screen.getByTestId('vim-nav-indicator')).toBeTruthy()
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    act(() => { ta.focus() })
    expect(screen.queryByTestId('vim-nav-indicator')).toBeNull()
    act(() => { ta.blur() })
  })
})
