// 2.1: Settings → MIDI & Ableton → "FoxBox device for Ableton Live". Main does the work (main/ableton/ipc.ts); the
// renderer only asks. Wiring: bridge.ts gets `readonly ableton?: AbletonBridge`, the preload maps it to these channels.

export const ABLETON_IPC = {
  status: 'fvwks:ableton-status',
  install: 'fvwks:ableton-install',
  remove: 'fvwks:ableton-remove',
  show: 'fvwks:ableton-show',
} as const

export interface AbletonView {
  /** The device is in Live's User Library and FoxBox has its port and secret. */
  installed: boolean
  /** The UDP port FoxBox sends to (null: not installed). */
  port: number | null
  /** The newest Live on this Mac, or null. */
  live: { edition: string; version: number; maxForLive: 'yes' | 'add-on' | 'no' } | null
}

export type AbletonResult = { ok: true; view: AbletonView } | { ok: false; error: string }

export interface AbletonBridge {
  status(): Promise<AbletonView | null>
  install(): Promise<AbletonResult>
  remove(): Promise<AbletonResult>
  /** Brings Live forward (or, without Live, shows the device file in Finder). */
  show(): Promise<void>
}
