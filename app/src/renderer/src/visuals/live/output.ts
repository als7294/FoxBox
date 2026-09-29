/**
 * The link between VISUALS and the output window (a projector or LED wall): main hands each window one end of a
 * MessageChannel (IPC.visualsPort, arriving here as a window message from the preload). The stage sends the frames it
 * draws, as ImageBitmaps (transferred, not copied); the output window shows them and draws nothing itself, so it is
 * the stage's picture by construction. One frame in flight at most: the output window says when it has shown one, and
 * frames drawn meanwhile are dropped (a slow or hidden output window never queues them up).
 */

export type OutputMessage = { type: 'frame'; bitmap: ImageBitmap } | { type: 'shown' }

/** A frame not acknowledged after this long is taken as lost (the window reloaded, or was hidden), and sending resumes. */
export const STALE_MS = 500

let port: MessagePort | null = null
/** Stage side: when the frame in flight was sent (0: none in flight). */
let inFlightAt = 0
/** Output side: the newest frame not yet shown. */
let pending: ImageBitmap | null = null
const listeners = new Set<() => void>()

/** Starts listening for the port (once, at app start, in both windows). */
export function initOutputLink(): void {
  window.addEventListener('message', (e) => {
    // Only the preload's handover (same window, our tag, with a port): nothing another frame could send.
    if (e.source !== window || (e.data as { fvwks?: unknown } | null)?.fvwks !== 'visuals-port' || !e.ports[0]) return
    linkPort(e.ports[0])
  })
}

/** Takes `p` as the link (a fresh one each time the output window opens or either window reloads). */
export function linkPort(p: MessagePort): void {
  port?.close()
  port = p
  inFlightAt = 0
  p.onmessage = (m) => receive(m.data as OutputMessage)
  p.start()
}

function receive(m: OutputMessage): void {
  if (m.type === 'shown') {
    inFlightAt = 0
    return
  }
  pending?.close()
  pending = m.bitmap
  for (const l of listeners) l()
}

/** Whether the stage may send a frame now (a link, and nothing in flight but a lost frame). */
export function canSendFrame(now = performance.now()): boolean {
  return port !== null && (inFlightAt === 0 || now - inFlightAt > STALE_MS)
}

/** Stage: sends what `canvas` shows now (a snapshot), unless the last frame is still on its way. */
export function sendFrame(canvas: HTMLCanvasElement): void {
  const p = port
  if (!p || !canSendFrame()) return
  inFlightAt = performance.now()
  createImageBitmap(canvas).then(
    (bitmap) => {
      if (port !== p) return bitmap.close()
      p.postMessage({ type: 'frame', bitmap } satisfies OutputMessage, [bitmap])
    },
    () => (inFlightAt = 0),
  )
}

/** Output window: the newest frame, taken (the caller owns it) and acknowledged, or null if none came since. */
export function takeFrame(): ImageBitmap | null {
  const b = pending
  pending = null
  if (b) port?.postMessage({ type: 'shown' } satisfies OutputMessage)
  return b
}

/** Output window: hears when a frame arrives. */
export function onOutputFrame(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
