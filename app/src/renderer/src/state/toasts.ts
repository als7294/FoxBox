import { hideHome } from '@/lib/paths'
import { create } from 'zustand'

export type ToastTone = 'info' | 'success' | 'warn' | 'error'

export interface ToastAction {
  label: string
  run: () => void
}

export interface ToastItem {
  id: number
  tone: ToastTone
  message: string
  detail?: string
  actions?: ToastAction[]
  /** File path shown as a draggable cartridge inside the toast (export success). */
  dragPath?: string
  timeoutMs: number
}

interface ToastStore {
  items: ToastItem[]
  push(t: Omit<ToastItem, 'id' | 'timeoutMs'> & { timeoutMs?: number }): number
  dismiss(id: number): void
}

let nextId = 1

export const useToasts = create<ToastStore>((set, get) => ({
  items: [],
  push(t) {
    const id = nextId++
    // The design's 3.8 s (the toast sits over the OUTPUT actions); errors stay longer.
    const timeoutMs = t.timeoutMs ?? (t.tone === 'error' ? 10_000 : t.actions?.length || t.dragPath ? 6_000 : 3_800)
    // Never a home folder on screen (anonymous act): an engine error or a path in the text shows it as "~".
    const shown = { ...t, message: hideHome(t.message), ...(t.detail ? { detail: hideHome(t.detail) } : {}) }
    const rest = get().items.filter((x) => x.message !== shown.message)
    set({ items: [...rest.slice(-2), { ...shown, id, timeoutMs }] })
    if (timeoutMs > 0) setTimeout(() => get().dismiss(id), timeoutMs)
    return id
  },
  dismiss(id) {
    set({ items: get().items.filter((t) => t.id !== id) })
  },
}))

type Extra = Partial<Pick<ToastItem, 'detail' | 'actions' | 'dragPath' | 'timeoutMs'>>

export const toast = {
  info: (message: string, extra: Extra = {}) => useToasts.getState().push({ tone: 'info', message, ...extra }),
  success: (message: string, extra: Extra = {}) => useToasts.getState().push({ tone: 'success', message, ...extra }),
  warn: (message: string, extra: Extra = {}) => useToasts.getState().push({ tone: 'warn', message, ...extra }),
  error: (message: string, extra: Extra = {}) => useToasts.getState().push({ tone: 'error', message, ...extra }),
}
