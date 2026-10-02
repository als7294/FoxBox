// Does a FoxBox-style hidden TouchDesigner put any window on screen (one a user could see and close, quitting it)?
// Builds the real FoxBox.toe (foxbox_setup.py and the presets, ports 7300-7302), launches it as FoxBox does
// (open -n -g -j), lists TouchDesigner's on-screen windows every second for 25 s (td_windows.js: owner, bounds; no
// pixels, no titles, no permission needed), then quits it by the pid it reports. As FoxBox does, it hides the app by
// the pid TouchDesigner writes as the project opens (booting.json) and again by the one it reports (status.json);
// NOHIDE=1 doesn't (the stray editor window stays), PERFORM=1 puts perform mode back. It prints TouchDesigner's own
// cook rate (status.json's fps, every 5 s; hidden, App Nap on, it held 60). Never shown: no TouchDesigner window on the
// user's screen, ever. (-NSAppSleepDisabled YES on its command line made it skip the project and quit: not used.)
//
//   node touchdesigner/dev/hidden_check.cjs
const { execFileSync } = require('node:child_process')
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const REPO = path.join(__dirname, '..', '..')
const OUT = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'foxbox-td-hidden-'))
const { outputFiles } = require(path.join(REPO, 'app/node_modules/esbuild')).buildSync({ entryPoints: [path.join(REPO, 'app/src/main/bridge/tdProject.ts')], bundle: true, platform: 'node', format: 'cjs', write: false })
const m = new Module('tdProject')
m._compile(outputFiles[0].text, 'tdProject.js')
const { readPresets, toeFiles, buildToe } = m.exports
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hide = (pid) => execFileSync('osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}).hide`])
const windows = () => JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', path.join(__dirname, 'td_windows.js'), 'TouchDesigner'], { encoding: 'utf8' }))
;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const status = path.join(OUT, 'status.json')
  fs.writeFileSync(status, '{}')
  const toe = await buildToe('/Applications/TouchDesigner.app', OUT, toeFiles(fs.readFileSync(path.join(REPO, 'touchdesigner/foxbox_setup.py'), 'utf8') + (process.env.PERFORM ? '\nui.performMode = True\n' : ''), { enabled: true, host: '127.0.0.1', outPort: 7300, inPort: 7301 }, status, '2025.33230', readPresets(path.join(REPO, 'touchdesigner/presets'))))
  console.log('before:', JSON.stringify(windows()))
  let launchPid = 0
  const args = []
  if (process.env.LAUNCH === 'open') {
    execFileSync('open', ['-n', '-g', '-j', '-a', '/Applications/TouchDesigner.app', toe, ...(args.length ? ['--args', ...args] : [])])
  } else {
    // as FoxBox does (tdSession.ts): the Syphon addon's NSWorkspace launch, its exact pid, re-hidden every 250 ms for 20 s
    const sy = require(path.join(REPO, 'app/native/syphon/build/syphon_host.node'))
    sy.launch('/Applications/TouchDesigner.app', toe, {}, args)
    for (let i = 0; i < 100 && !launchPid; i++) {
      launchPid = sy.launched()
      if (!launchPid) await sleep(100)
    }
    console.log('launched pid', launchPid)
    const until = Date.now() + 20000
    const t = setInterval(() => (Date.now() > until ? clearInterval(t) : sy.hideApp(launchPid)), 250)
  }
  let pid = 0, seen = [], hidBoot = false, hidReport = false
  for (let s = 1; s <= 25; s++) {
    await sleep(1000)
    try { pid ||= JSON.parse(fs.readFileSync(status, 'utf8')).pid || 0 } catch {}
    if (!process.env.NOHIDE) {
      try {
        const boot = JSON.parse(fs.readFileSync(path.join(OUT, 'booting.json'), 'utf8')).pid
        if (boot && !hidBoot) hide(boot), (hidBoot = s)
      } catch {}
      if (pid && !hidReport) hide(pid), (hidReport = s)
      if (launchPid > 0 && pid && pid !== launchPid) console.log('MISMATCH: launched', launchPid, 'reported', pid)
    }
    const w = windows()
    if (w.onScreen.length) seen.push({ s, pid, onScreen: w.onScreen })
    let cook = '-'
    try { cook = JSON.parse(fs.readFileSync(status, 'utf8')).fps ?? '-' } catch {}
    if (s % 5 === 0) console.log(`t=${s}s reported pid ${pid || '-'} | TD windows ${w.total}, on screen ${w.onScreen.length} | cook ${cook} fps`)
  }
  console.log('on screen at (s):', seen.map((x) => x.s).join(',') || 'never', '| hidden on boot at', hidBoot || '-', 's, on report at', hidReport || '-', 's')
  try { const st = JSON.parse(fs.readFileSync(status, 'utf8')); console.log('status:', JSON.stringify({ ok: st.ok, errors: (st.errors || []).length, missing: (st.missing || []).length, fps: st.fps })) } catch {}
  if (pid) { process.kill(pid, 'SIGTERM'); await sleep(1500) }
  console.log('after quit:', JSON.stringify(windows()))
  fs.rmSync(OUT, { recursive: true, force: true })
})()
