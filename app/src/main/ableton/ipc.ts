// 2.1: the main side of Settings → MIDI & Ableton's device row. Wiring (index.ts): registerAbletonIpc(ipcMain, {
//   where: () => ({ userData: USER_DATA, home: homedir() }), trusted, openPath: shell.openPath, showItem: shell.showItemInFolder })
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { ABLETON_IPC, type AbletonResult, type AbletonView } from '../../shared/ableton'
import { deviceStatus, installDevice, removeDevice, type AbletonStatus, type Where } from './foxbox-ableton'

export interface AbletonDeps {
  where(): Where
  trusted(event: IpcMainInvokeEvent): boolean
  openPath(path: string): Promise<unknown>
  showItem(path: string): void
}

export function abletonView(s: AbletonStatus): AbletonView {
  const live = s.live[0]
  return { installed: s.installed, port: s.port, live: live ? { edition: live.edition, version: live.version, maxForLive: live.maxForLive } : null }
}

const failed = (err: unknown): AbletonResult => ({ ok: false, error: err instanceof Error ? err.message : String(err) })

export function registerAbletonIpc(ipc: Pick<IpcMain, 'handle'>, deps: AbletonDeps): void {
  ipc.handle(ABLETON_IPC.status, (e) => (deps.trusted(e) ? abletonView(deviceStatus(deps.where())) : null))
  ipc.handle(ABLETON_IPC.install, async (e): Promise<AbletonResult> => {
    if (!deps.trusted(e)) return { ok: false, error: 'Refused.' }
    try {
      return { ok: true, view: abletonView(await installDevice(deps.where())) }
    } catch (err) {
      return failed(err)
    }
  })
  ipc.handle(ABLETON_IPC.remove, (e): AbletonResult => {
    if (!deps.trusted(e)) return { ok: false, error: 'Refused.' }
    try {
      return { ok: true, view: abletonView(removeDevice(deps.where())) }
    } catch (err) {
      return failed(err)
    }
  })
  ipc.handle(ABLETON_IPC.show, async (e) => {
    if (!deps.trusted(e)) return
    const s = deviceStatus(deps.where())
    if (s.live[0]) await deps.openPath(s.live[0].path)
    else deps.showItem(s.device)
  })
}
