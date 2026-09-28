/**
 * The link between the LIVE page and the output window (a projector or LED wall): main hands each window one end of
 * a MessageChannel (IPC.visualsPort, arriving here as a window message from the preload). The LIVE page sends the
 * chosen style and palette, then one AudioFrame per drawn frame; the output window draws the same style from them.
 */
import type { AudioFrame } from './registry'

export type OutputMessage = { type: 'style'; styleId: string; paletteId: string } | { type: 'frame'; frame: AudioFrame }

let port: MessagePort | null = null
const listeners = new Set<(m: OutputMessage) => void>()
let lastStyle: Extract<OutputMessage, { type: 'style' }> | null = null

/** Starts listening for the port (once, at app start, in both windows). */
export function initOutputLink(): void {
  window.addEventListener('message', (e) => {
    // Only the preload's handover (same window, our tag, with a port): nothing another frame could send.
    if (e.source !== window || (e.data as { fvwks?: unknown } | null)?.fvwks !== 'visuals-port' || !e.ports[0]) return
    port?.close()
    port = e.ports[0]
    port.onmessage = (m) => {
      for (const l of listeners) l(m.data as OutputMessage)
    }
    port.start()
    // A fresh link (the output window just opened, or reloaded): tell it what to draw.
    if (lastStyle) port.postMessage(lastStyle)
  })
}

/** LIVE page: the style and palette to show. */
export function sendStyle(styleId: string, paletteId: string): void {
  lastStyle = { type: 'style', styleId, paletteId }
  port?.postMessage(lastStyle)
}

/** LIVE page: this frame's sound (cheap: a few KB, sent only while the output window is linked). */
export function sendFrame(frame: AudioFrame): void {
  port?.postMessage({ type: 'frame', frame } satisfies OutputMessage)
}

/** Output window: what the LIVE page sends. */
export function onOutputMessage(cb: (m: OutputMessage) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export const outputLinked = (): boolean => port !== null
