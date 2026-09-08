/**
 * VimNavIndicator — the normal-mode cue for vim-style navigation.
 *
 * DOM focus is the mode, and leaving the composer would otherwise be
 * invisible: focus lands on the transcript scroller, whose focus ring is
 * suppressed like most container rings, so without this pill "my keyboard
 * stopped typing" is exactly what exit-insert looks like to someone who
 * pressed Esc by reflex.
 *
 * Shown only while vim navigation is enabled AND bare keys are live — i.e.
 * the focused element is not an editable surface. Tracking uses `focusin` /
 * `focusout` (they bubble to the document; plain focus/blur do not), plus a
 * `focusout` special case: when focus moves to nothing (`relatedTarget`
 * null), `document.activeElement` still names the OLD element during the
 * event, so the state is re-read on the next frame.
 */
import { useEffect, useState } from 'react'

import { isEditableTarget } from '../lib/vimNav'
import { i18nT } from '../i18n/t'

function inNormalMode(): boolean {
  return !isEditableTarget(document.activeElement)
}

export default function VimNavIndicator({ enabled }: { enabled: boolean }) {
  const [normal, setNormal] = useState(inNormalMode)

  useEffect(() => {
    if (!enabled) return
    const sync = () => setNormal(inNormalMode())
    const deferredSync = () => requestAnimationFrame(sync)
    document.addEventListener('focusin', sync)
    document.addEventListener('focusout', deferredSync)
    sync()
    return () => {
      document.removeEventListener('focusin', sync)
      document.removeEventListener('focusout', deferredSync)
    }
  }, [enabled])

  if (!enabled || !normal) return null
  return (
    <div
      role="status"
      data-testid="vim-nav-indicator"
      className="fixed bottom-3 right-3 z-40 pointer-events-none select-none rounded-full border border-border px-2.5 py-1 text-[11px] font-semibold tracking-wider text-muted"
      style={{ background: 'var(--bg)' }}
    >
      {i18nT('components.vimNavIndicator.normal_mode')}
    </div>
  )
}
