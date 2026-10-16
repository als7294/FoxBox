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
  const mac = process.platform === 'darwin' // W1: Windows gets File / Edit / View / Window / Help, About and Quit in them
  const template: MenuItemConstructorOptions[] = [
    // The app menu by hand: no ⌘H on Hide, which hides the output window (a projector) along with the app.
    ...((mac
      ? [
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
        ]
      : []) as MenuItemConstructorOptions[]),
    {
      label: 'File',
      submenu: [
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => send('open-settings') },
        { type: 'separator' },
        mac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        // ⌘R restarts the page (mid-set): dev builds only.
        ...(isDev
          ? ([
              { role: 'reload' },
              { role: 'forceReload' },
              { role: 'toggleDevTools' },
              { type: 'separator' },
            ] as MenuItemConstructorOptions[])
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
      submenu: [...(mac ? [] : [{ role: 'about' } as const]), { label: 'Open Engine Logs', click: openLogs }],
    },
  ]
  return Menu.buildFromTemplate(template)
}
