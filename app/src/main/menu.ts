import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '../shared/bridge'

/**
 * Native menu. Shortcuts are handled in the renderer (one source of truth, and they also work in the
 * browser build), so the accelerators here are display-only (`registerAccelerator: false`).
 */
export function buildMenu(
  send: (command: MenuCommand) => void,
  openLogs: () => void,
  isDev: boolean,
  zoom: (step: -1 | 0 | 1) => void,
): Menu {
  const template: MenuItemConstructorOptions[] = [
    // The app menu by hand: no ⌘H on Hide, which hides the output window (a projector) along with the app.
    {
      role: 'appMenu',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { label: 'Hide FoxBox', click: () => app.hide() },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('open-settings') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        // ⌘R restarts the page (mid-set): dev builds only.
        ...(isDev
          ? ([{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }] as MenuItemConstructorOptions[])
          : []),
        // Page zoom is display-only too: ⌘+ / ⌘− reach the page first.
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', registerAccelerator: false, click: () => zoom(0) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', registerAccelerator: false, click: () => zoom(1) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', registerAccelerator: false, click: () => zoom(-1) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: 'Open Engine Logs', click: openLogs }],
    },
  ]
  return Menu.buildFromTemplate(template)
}
