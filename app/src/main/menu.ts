import { Menu, type MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '../shared/bridge'

/**
 * Native menu. Shortcuts are handled in the renderer (one source of truth, and they also work in the
 * browser build), so the accelerators here are display-only (`registerAccelerator: false`).
 */
export function buildMenu(send: (command: MenuCommand) => void, openLogs: () => void, isDev: boolean): Menu {
  const item = (label: string, accelerator: string, command: MenuCommand): MenuItemConstructorOptions => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: () => send(command),
  })
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        item('Final Render', 'CmdOrCtrl+Enter', 'render-final'),
        item('Export', 'CmdOrCtrl+Shift+E', 'export'),
        item('Save Preset…', 'CmdOrCtrl+S', 'save-preset'),
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('open-settings') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Playback',
      submenu: [item('Play / Pause', 'Space', 'play'), item('A/B Dry–Wet', '\\', 'toggle-ab'), item('Loop', 'L', 'toggle-loop')],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        ...(isDev ? ([{ role: 'forceReload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[]) : []),
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: '?', registerAccelerator: false, click: () => send('shortcuts') },
        { label: 'Open Engine Logs', click: openLogs },
      ],
    },
  ]
  return Menu.buildFromTemplate(template)
}
