import { useEffect, useRef } from 'react'

/**
 * One shared requestAnimationFrame loop for every canvas. It stops when nothing is subscribed and
 * pauses while the window is hidden, so the render loop never competes with the engine for nothing.
 */
type FrameFn = (now: number) => void

const subs = new Set<FrameFn>()
let raf = 0

function loop(now: number) {
  raf = 0
  if (typeof document !== 'undefined' && document.hidden) return
  for (const fn of subs) {
    try {
      fn(now)
    } catch (err) {
      console.error('[frame]', err)
    }
  }
  if (subs.size) raf = requestAnimationFrame(loop)
}

function kick() {
  if (!raf && subs.size && typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(loop)
}

if (typeof document !== 'undefined') document.addEventListener('visibilitychange', kick)

export function addFrame(fn: FrameFn): () => void {
  subs.add(fn)
  kick()
  return () => {
    subs.delete(fn)
  }
}

/** Calls `fn` every frame while mounted (the latest closure is used, no re-subscribe per render). */
export function useFrame(fn: FrameFn): void {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => addFrame((now) => ref.current(now)), [])
}
