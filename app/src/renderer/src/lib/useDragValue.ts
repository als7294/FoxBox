import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { fromPosition, nudge, toPosition, type Range } from './scale'

export interface DragValueOptions extends Range {
  value: number
  defaultValue: number
  onChange(value: number): void
  /** Called once per gesture, on release: pointer up, key up, wheel pause, double-click reset. */
  onCommit?(value: number): void
  /** Pixels of vertical drag for the full range. */
  travel?: number
  orientation?: 'vertical' | 'horizontal'
  /** Horizontal faders: jump to the pressed point, then track the pointer 1:1 across the element. */
  absolute?: boolean
  disabled?: boolean
}

/**
 * Shared interaction model for Knob and Fader: vertical (or horizontal) drag with Shift for fine
 * control, double-click to reset, wheel, and arrow / Page / Home / End keys.
 */
export function useDragValue(o: DragValueOptions) {
  const [active, setActive] = useState(false)
  const drag = useRef<{ anchorPos: number; anchorT: number; id: number; shift: boolean; travel: number } | null>(null)
  const latest = useRef(o.value)
  latest.current = o.value
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const range: Range = { min: o.min, max: o.max, scale: o.scale ?? 'lin', step: o.step ?? null }
  const travel = o.travel ?? 180
  const vertical = (o.orientation ?? 'vertical') === 'vertical'

  const change = useCallback(
    (v: number) => {
      if (v === latest.current) return
      latest.current = v
      o.onChange(v)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [o.onChange],
  )

  useEffect(
    () => () => {
      if (wheelTimer.current) clearTimeout(wheelTimer.current)
    },
    [],
  )

  const onPointerDown = (e: PointerEvent<HTMLElement>) => {
    if (o.disabled || e.button !== 0) return
    e.preventDefault()
    e.currentTarget.focus()
    e.currentTarget.setPointerCapture(e.pointerId)
    let anchorT = toPosition(o.value, range)
    let span = travel
    if (o.absolute && !vertical) {
      const rect = e.currentTarget.getBoundingClientRect()
      if (rect.width > 0) {
        span = rect.width
        anchorT = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
        change(fromPosition(anchorT, range))
      }
    }
    drag.current = {
      anchorPos: vertical ? e.clientY : e.clientX,
      anchorT,
      id: e.pointerId,
      shift: e.shiftKey,
      travel: span,
    }
    setActive(true)
  }

  const onPointerMove = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    const pos = vertical ? e.clientY : e.clientX
    // Re-anchor when Shift toggles mid-drag so the value doesn't jump.
    if (e.shiftKey !== d.shift) {
      d.anchorPos = pos
      d.anchorT = toPosition(latest.current, range)
      d.shift = e.shiftKey
    }
    const delta = vertical ? d.anchorPos - pos : pos - d.anchorPos
    change(fromPosition(d.anchorT + (delta / d.travel) * (d.shift ? 0.1 : 1), range))
  }

  const endDrag = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    drag.current = null
    setActive(false)
    o.onCommit?.(latest.current)
  }

  const onDoubleClick = () => {
    if (o.disabled) return
    change(o.defaultValue)
    o.onCommit?.(o.defaultValue)
  }

  // Wheel: a native non-passive listener, so turning a knob doesn't also scroll the rack panel.
  const onWheel = useRef<(e: WheelEvent) => void>(() => {})
  onWheel.current = (e: WheelEvent) => {
    if (o.disabled) return
    const dy = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? -e.deltaY : e.deltaX
    if (dy === 0) return
    e.preventDefault()
    change(nudge(latest.current, range, dy > 0 ? 1 : -1, e.shiftKey ? 'fine' : 'normal'))
    if (wheelTimer.current) clearTimeout(wheelTimer.current)
    wheelTimer.current = setTimeout(() => o.onCommit?.(latest.current), 250)
  }
  const wheelTarget = useRef<HTMLElement | null>(null)
  const wheelListener = useRef((e: WheelEvent) => onWheel.current(e))
  const ref = useCallback((el: HTMLElement | null) => {
    wheelTarget.current?.removeEventListener('wheel', wheelListener.current)
    el?.addEventListener('wheel', wheelListener.current, { passive: false })
    wheelTarget.current = el
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (o.disabled) return
    let next: number | null = null
    const size = e.shiftKey ? 'fine' : 'normal'
    switch (e.key) {
      case 'ArrowUp':
      case 'ArrowRight':
        next = nudge(latest.current, range, 1, size)
        break
      case 'ArrowDown':
      case 'ArrowLeft':
        next = nudge(latest.current, range, -1, size)
        break
      case 'PageUp':
        next = nudge(latest.current, range, 1, 'page')
        break
      case 'PageDown':
        next = nudge(latest.current, range, -1, 'page')
        break
      case 'Home':
        next = o.min
        break
      case 'End':
        next = o.max
        break
      case 'Delete':
      case 'Backspace':
        next = o.defaultValue
        break
      default:
        return
    }
    e.preventDefault()
    e.stopPropagation()
    change(next)
  }

  const onKeyUp = (e: KeyboardEvent<HTMLElement>) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', 'Delete', 'Backspace'].includes(e.key)) {
      o.onCommit?.(latest.current)
    }
  }

  return {
    active,
    position: toPosition(o.value, range),
    handlers: {
      ref,
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onDoubleClick,
      onKeyDown,
      onKeyUp,
    },
  }
}
