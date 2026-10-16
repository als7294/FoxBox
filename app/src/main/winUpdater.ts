// W1 (the Windows beta): app updates through electron-updater. The NSIS installer's GitHub feed (latest.yml, with a
// blockmap, so an asar-only change downloads as a small delta), checked at launch and every 6 hours, downloaded in the
// background and installed when FoxBox quits (Windows can't replace a running exe). The Mac keeps updater.ts.
// ponytail: no in-app update UI on Windows yet (Settings says updates are automatic); a progress card once it's asked for.
const SIX_HOURS = 6 * 3600_000

export async function startWinUpdates(log: (line: string) => void): Promise<void> {
  const { autoUpdater } = await import('electron-updater') // its own chunk: the Mac never loads it
  const say = (m: unknown) => log(String(m))
  autoUpdater.logger = { info: say, warn: say, error: say, debug: () => {} }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('update-downloaded', (info) => log(`${info.version} downloaded; it installs when FoxBox quits`))
  const check = () => void autoUpdater.checkForUpdates().catch((err: Error) => log(`check failed: ${err.message}`))
  check()
  setInterval(check, SIX_HOURS).unref()
}
