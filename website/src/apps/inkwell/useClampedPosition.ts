/**
 * Keep an absolutely-positioned popover inside its offset parent.
 *
 * Popovers open at the passage (`left: anchor.x`, `top: anchor.y`), which
 * near the right or bottom edge of the editor pane would spill over the
 * neighbouring pane or clip (sweep finding, 2026-09-10). After layout, the
 * hook measures the box against its offsetParent and returns a corrected
 * style: shifted left so its right edge stays inside, and moved above the
 * anchor when there is no room below.
 */
import { useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'

const MARGIN = 8

export function useClampedPosition(
  ref: RefObject<HTMLElement | null>,
  desired: { left: number; top: number } | null,
): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>(desired ? { left: desired.left, top: desired.top } : {})
  useLayoutEffect(() => {
    if (!desired) return
    const el = ref.current
    const parent = el?.offsetParent as HTMLElement | null
    if (!el || !parent) {
      setStyle({ left: desired.left, top: desired.top })
      return
    }
    const w = el.offsetWidth
    const h = el.offsetHeight
    const maxLeft = Math.max(MARGIN, parent.clientWidth - w - MARGIN)
    const left = Math.min(Math.max(MARGIN, desired.left), maxLeft)
    let top = desired.top
    if (top + h + MARGIN > parent.clientHeight) {
      // No room below the anchor: try above it, else pin to the bottom edge.
      const above = desired.top - h - 2 * MARGIN
      top = above >= MARGIN ? above : Math.max(MARGIN, parent.clientHeight - h - MARGIN)
    }
    setStyle({ left, top })
  }, [ref, desired?.left, desired?.top]) // eslint-disable-line react-hooks/exhaustive-deps
  return style
}
