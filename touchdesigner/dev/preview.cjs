// TouchDesigner preset preview (1.6, for preset authors): builds FoxBox.toe from touchdesigner/presets as FoxBox does
// (app/src/main/bridge/tdProject.ts), opens its own hidden TouchDesigner on other ports and Syphon names (a FoxBox or
// TouchDesigner you have open is never touched), plays a DJ clip as the camera with a test person matte, sends
// channels at 128 bpm, a ring of face landmarks and a scripted body and hands, and saves a PNG per preset and pose:
// arms up, a sweep, a pinch, a FRAME, a drop, no one found; prints per preset the frames a second it sent, the frame
// intervals' 95th percentile and longest (choppiness), its cook ms a frame in TouchDesigner and dearest operators (a
// v3 preset; the budget is 12 ms), the worst flashes a second (WCAG-style, whole picture and
// quarters; the user's rule is 3 at most), and, per
// state, how much of the picture moves in 250 ms (a frozen state is listed). A preset's window that a Blender render or
// a load of 8+ touched, or one on battery, is run again after 60 s clean (clean: false after 5 tries); PLEXUS runs again
// last as a control, and POINT CLOUD once with Syphon Out off (the A/B). Then quits its TouchDesigner by its pid.
// The real tracking comes only from the app.
//
//   cd app && npx electron ../touchdesigner/dev/preview.cjs [preset ids...]
//   PREVIEW_CLIP=<mp4> (required: a clip of a person)  PREVIEW_OUT=<dir> (default <tmp>/foxbox-td-preview)
const { app, BrowserWindow, sharedTexture, ipcMain } = require('electron')
const { execFileSync } = require('node:child_process')
const dgram = require('node:dgram')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

const APP = path.join(__dirname, '..', '..', 'app')
const TD = '/Applications/TouchDesigner.app'
const OUT = process.env.PREVIEW_OUT || path.join(os.tmpdir(), 'foxbox-td-preview')
const CLIP = process.env.PREVIEW_CLIP
if (!CLIP) { console.error('set PREVIEW_CLIP to an mp4 of a person'); process.exit(2) }
const PORTS = { enabled: true, host: '127.0.0.1', outPort: 7100, inPort: 7101 } // FoxBox's are 7000-7002
const SENDER = 'FoxBox 7100' // tdSender: other ports, other Syphon names

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A scripted person (camera frame, 0-1, y down; facing the camera, so their left shoulder is on screen right).
const POSES = ['arms', 'sweep', 'pinch', 'frame']
function body(pose, t) {
  const pts = Array.from({ length: 33 }, () => [0, 0, 0])
  const put = (i, x, y) => (pts[i] = [x, y, 1])
  put(0, 0.5, 0.36)
  const sh = { 11: [0.6, 0.55], 12: [0.4, 0.55] }
  put(11, ...sh[11])
  put(12, ...sh[12])
  put(23, 0.56, 0.92)
  put(24, 0.44, 0.92)
  for (const [s, e, w, dir] of [[11, 13, 15, 1], [12, 14, 16, -1]]) {
    const a = pose === 'sweep' ? -Math.PI / 2 + dir * (0.4 + 0.9 * Math.sin(t * 2.2)) : pose === 'arms' ? -Math.PI / 2 + dir * 0.45 : -Math.PI / 2 + dir * 1.2
    const reach = pose === 'frame' || pose === 'pinch' ? 0.12 : 0.15
    const [sx, sy] = sh[s]
    const [ex, ey] = [sx + Math.cos(a) * reach * 1.1, sy + Math.sin(a) * reach * 1.25]
    put(e, ex, ey)
    const b = pose === 'frame' || pose === 'pinch' ? a - dir * 1.6 : a
    put(w, ex + Math.cos(b) * reach * 1.1, ey + Math.sin(b) * reach * 1.25)
  }
  return pts
}
/** 21 MediaPipe points round a wrist: the fingers fanned up; `pinch` closes thumb and index; `ell`: an L (thumb and
 *  index out, the rest folded) for the FRAME. */
function hand(wx, wy, side, pinch, ell) {
  const fan = side === 0 ? [-1.05, -0.35, 0, 0.3, 0.6] : [1.05, 0.35, 0, -0.3, -0.6]
  const pts = [[wx, wy]]
  fan.forEach((a, f) => {
    const folded = ell && f > 1
    const len = f === 0 ? 0.05 : folded ? 0.035 : 0.075
    for (let j = 1; j <= 4; j++) {
      const r = (len * j) / 4 + (f === 0 ? 0 : 0.03)
      const turn = folded ? j * 0.5 : 0
      pts.push([wx + Math.sin(a + turn * (side ? -1 : 1)) * r * 0.56, wy - Math.cos(a) * r])
    }
  })
  const mid = [(pts[4][0] + pts[8][0]) / 2, (pts[4][1] + pts[8][1]) / 2]
  for (const i of [4, 8]) pts[i] = [pts[i][0] + (mid[0] - pts[i][0]) * pinch, pts[i][1] + (mid[1] - pts[i][1]) * pinch]
  return pts
}
const pids = () => {
  try {
    return execFileSync('pgrep', ['-x', 'TouchDesigner'], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number)
  } catch {
    return []
  }
}
const pad = (b) => Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))])
const osc = (address, value) => {
  const v = Buffer.alloc(4)
  v.writeFloatBE(value)
  return Buffer.concat([pad(Buffer.from(address)), pad(Buffer.from(',f')), v])
}
const oscText = (address, text) => Buffer.concat([pad(Buffer.from(address)), pad(Buffer.from(',s')), pad(Buffer.from(text))])
/** tdProject.ts, as FoxBox runs it (bundled on the fly). */
function tdProject() {
  const { outputFiles } = require(path.join(APP, 'node_modules', 'esbuild')).buildSync({
    entryPoints: [path.join(APP, 'src', 'main', 'bridge', 'tdProject.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    write: false,
  })
  const m = new Module('tdProject')
  m._compile(outputFiles[0].text, 'tdProject.js')
  return m.exports
}

app.whenReady().then(async () => {
  const sy = require(path.join(APP, 'native', 'syphon', 'build', 'syphon_host.node'))
  const { readPresets, toeFiles, buildToe } = tdProject()
  const only = process.argv.slice(2).filter((a) => /^[a-z0-9_-]+$/.test(a))
  const presets = readPresets(path.join(__dirname, '..', 'presets'), (id, why) => console.log(`preset ${id} skipped: ${why}`))
  const template = fs.readFileSync(path.join(__dirname, '..', 'foxbox_setup.py'), 'utf8')
  fs.mkdirSync(OUT, { recursive: true })
  const status = path.join(OUT, 'status.json')
  fs.writeFileSync(status, '{}')
  fs.rmSync(path.join(OUT, 'booting.json'), { force: true })
  const toe = await buildToe(TD, OUT, toeFiles(template, PORTS, status, '2025.33230', presets))

  process.env.PREVIEW_CLIP_URL = 'file://' + CLIP
  // Hidden windows (someone may be using the Mac), still painting.
  const prefs = { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: false, sandbox: false, webSecurity: false, backgroundThrottling: false }
  const cam = new BrowserWindow({ width: 320, height: 200, title: 'camera', show: false, paintWhenInitiallyHidden: true, webPreferences: prefs })
  const back = new BrowserWindow({ width: 640, height: 380, title: 'TouchDesigner', show: false, paintWhenInitiallyHidden: true, webPreferences: prefs })
  sy.serve(`${SENDER} Camera`)
  ipcMain.on('cam', (_e, buf) => sy.publish(Buffer.from(buf), 960, 540))
  await cam.loadFile(path.join(__dirname, 'preview.html'), { query: { role: 'cam' } })
  await back.loadFile(path.join(__dirname, 'preview.html'))

  // As FoxBox launches it (the addon: a new instance, hidden and not activated from the start, its exact pid; re-hidden
  // every 250 ms for 20 s), with its cook times on (foxbox_setup's perf). No launch arguments: TouchDesigner skips the
  // project with them.
  sy.launch(TD, toe, { FOXBOX_TD_PERF: '1' })
  let launchPid = 0
  for (let i = 0; i < 200 && launchPid === 0; i++) {
    launchPid = sy.launched()
    await sleep(100)
  }
  if (launchPid > 0) {
    const until = Date.now() + 20000
    const t = setInterval(() => (Date.now() > until ? clearInterval(t) : sy.hideApp(launchPid)), 250)
  }
  let pid = launchPid > 0 ? launchPid : 0
  let server
  // As FoxBox does: hide it by the pid it writes as the project opens, and again once it reports (its editor window
  // comes on screen even from a hidden launch, and anyone closing it quits it mid-run)
  const hide = (p) => execFileSync('osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit'); $.NSRunningApplication.runningApplicationWithProcessIdentifier(${p}).hide`])
  let hidBoot = false
  for (let i = 0; i < 600 && !server; i++) {
    try {
      pid ||= JSON.parse(fs.readFileSync(status, 'utf8')).pid || 0 // its own report: a new pid could be anyone's
    } catch {}
    try {
      const boot = JSON.parse(fs.readFileSync(path.join(OUT, 'booting.json'), 'utf8')).pid
      if (boot && !hidBoot) hide(boot), (hidBoot = true)
    } catch {}
    server = sy.servers().find((s) => s.name === SENDER)
    await sleep(100)
  }
  if (pid) hide(pid)
  const sock = dgram.createSocket('udp4')
  const st = { preset: 0, face: 1, drop: 0, pose: 'arms', maskfirst: 0, run: 0, syphonoff: 0 }
  let frame = 0
  const feed = setInterval(() => {
    const t = frame++ / 60
    const beat = (t * 128) / 60
    const send = (name, v) => sock.send(osc('/foxbox/' + name, v), PORTS.outPort, '127.0.0.1')
    const kick = Math.max(0, 1 - (beat % 1) * 4)
    send('kick', kick)
    send('react', kick)
    send('snare', Math.max(0, 1 - ((beat + 0.5) % 1) * 4))
    send('beat', Math.floor(beat))
    send('beatphase', beat % 1)
    send('kickcount', Math.floor(beat))
    send('snarecount', Math.floor(beat))
    send('dropenergy', st.drop)
    send('maskfirst', st.maskfirst)
    send('td_preset', st.preset)
    send('perfrun', st.run)
    send('perfsyphon', st.syphonoff)
    const p = presets[st.preset]
    for (let i = 0; i < 4; i++) send(`tdmacro${i}`, p?.macros[i]?.default ?? 0)
    send('face', st.face)
    send('npts', st.face ? 28 : 0)
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * Math.PI * 2
      const r = i % 2 ? 0.6 : 1
      send(`pt${i}x`, 0.5 + 0.05 * Math.cos(a) * r)
      send(`pt${i}y`, 0.36 + 0.09 * Math.sin(a) * r)
    }
    const b = body(st.pose, t)
    send('nbody', st.face ? 33 : 0)
    b.forEach(([x, y, v], i) => (send(`b${i}x`, x), send(`b${i}y`, y), send(`b${i}v`, v)))
    const pinch = st.pose === 'pinch' ? 0.5 + 0.5 * Math.sin(t * 5) : 0
    const ell = st.pose === 'frame'
    // the hands on the wrists: screen-left is the person's right wrist (16)
    for (const [k, w, side] of [['hl', 16, 0], ['hr', 15, 1]]) {
      send(`${k}on`, st.face)
      hand(b[w][0], b[w][1], side, pinch, ell).forEach(([x, y], i) => (send(`${k}${i}x`, x), send(`${k}${i}y`, y)))
      send(`${k}gest`, ell ? 3 : st.pose === 'pinch' ? 0 : 2) // pinching: no canned sign (an open palm would wipe AIR DRAW)
      send(`${k}pinch`, pinch)
      send(`${k}open`, 1 - pinch)
      send(`${k}fingers`, ell ? 2 : 5)
    }
    send('apart', Math.abs(b[15][0] - b[16][0]))
    send('fheld', ell && st.face ? 1 : 0)
    send('fsize', ell ? Math.abs(b[15][0] - b[16][0]) : 0)
    const [x0, x1] = [Math.min(b[15][0], b[16][0]), Math.max(b[15][0], b[16][0])]
    const [y0, y1] = [Math.min(b[15][1], b[16][1]) - 0.08, Math.max(b[15][1], b[16][1]) + 0.02]
    ;[[x0, y0], [x1, y0], [x1, y1], [x0, y1]].forEach(([x, y], i) => (send(`f${i}x`, x), send(`f${i}y`, y)))
    send('triangle', 0)
  }, 1000 / 60)
  try {
    if (!server) throw new Error("TouchDesigner's picture never appeared (is it activated? see " + status + ')')
    sy.connect(server.uuid)
    const pump = setInterval(() => {
      const f = sy.take()
      if (!f) return
      const imp = sharedTexture.importSharedTexture({
        textureInfo: { pixelFormat: 'bgra', codedSize: { width: f.width, height: f.height }, handle: { ioSurface: f.surface } },
        allReferencesReleased: () => sy.release(f.surface),
      })
      sharedTexture
        .sendSharedTexture({ frame: back.webContents.mainFrame, importedSharedTexture: imp })
        .catch(() => {})
        .finally(() => imp.release())
    }, 16)
    const snap = async (name) => {
      const url = await back.webContents.executeJavaScript('window.__snap ? window.__snap() : ""')
      if (url) fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(url.split(',')[1], 'base64'))
    }
    // Per preset: the frames TouchDesigner sent a second while it showed, and per state the motion check (the share of
    // pixels that change over 250 ms: 0 is a frozen picture).
    const report = {}
    const MAX_TRIES = 5
    // On battery a Mac throttles (the runs before 18:12 were, unseen): a window counts only on AC power.
    const power = () => {
      try {
        return execFileSync('pmset', ['-g', 'batt'], { encoding: 'utf8' })
      } catch {
        return ''
      }
    }
    const battery = () => (power().match(/(\d+)%/) || [])[1] + '% ' + (power().includes("'AC Power'") ? 'AC' : 'battery')
    const cookOf = (id) => {
      try {
        return JSON.parse(fs.readFileSync(status + '.perf.json', 'utf8'))['p_' + id] ?? null
      } catch {
        return null
      }
    }
    const busy = () => {
      try {
        execFileSync('pgrep', ['-f', 'Blender.*--background'], { stdio: 'ignore' })
        return 'a Blender render'
      } catch {}
      if (!power().includes("'AC Power'")) return 'on battery'
      return os.loadavg()[0] >= 8 ? `load ${os.loadavg()[0].toFixed(1)}` : null
    }
    let dirty = null
    const watch = setInterval(() => (dirty ||= busy()), 1000)
    const waitClean = async () => {
      for (let ok = 0; ok < 60; ok = busy() ? 0 : ok + 1) await sleep(1000)
    }
    const got = () => back.webContents.executeJavaScript('window.__got')
    const motion = () => back.webContents.executeJavaScript('window.__motion(250)')
    // Every preset, then PLEXUS again as a control (it drops at the end only if the machine drifted: power, heat).
    const order = presets.map((p, i) => [i, p, p.id]).filter(([, p]) => !only.length || only.includes(p.id))
    const control = presets.findIndex((p) => p.id === 'plexus')
    if (control >= 0 && !only.length) order.push([control, presets[control], 'plexus_control'])
    for (const [i, p, key] of order) {
      // Render-aware (Codex's Blender renders start on their own): a window a render or a load of 8+ touched is run again
      // from the start after 60 s clean; only clean windows count (MAX_TRIES, then it's reported not clean).
      for (let attempt = 1; ; attempt++) {
        if (busy()) await waitClean()
        dirty = null
        st.run++ // a new perf window: TouchDesigner's perf starts this preset's sums afresh
        Object.assign(st, { preset: i, face: 1, drop: 0 })
        const [g0, t0, p0] = [await got(), Date.now(), await back.webContents.executeJavaScript('performance.now()')]
        const moved = {}
        for (const pose of POSES) {
          st.pose = pose
          await sleep(1200)
          await snap(`${key}-${pose}`)
          moved[pose] = await motion()
        }
        st.drop = 1
        await sleep(800)
        await snap(key + '-drop')
        moved.drop = await motion()
        Object.assign(st, { drop: 0, face: 0 })
        await sleep(1200)
        await snap(key + '-noone')
        moved.noone = await motion()
        const fps = ((await got()) - g0) / ((Date.now() - t0) / 1000)
        const intervals = await back.webContents.executeJavaScript(`window.__intervals(${p0})`)
        const flashes = await back.webContents.executeJavaScript(`window.__flashes(${p0})`)
        const cook = cookOf(p.id)
        // MASK FIRST switched on (a preset with memory): its trails must clear at once, so the picture's mean beside the
        // person (the outer columns, where only trails are) drops.
        let maskFirst = null
        if (p.feedback || /feedbackTOP|texture3dTOP/.test(p.build || '')) {
          const mean = () => back.webContents.executeJavaScript('window.__lum.length ? window.__lum[window.__lum.length - 1][1][5] : -1')
          Object.assign(st, { face: 1, pose: 'sweep' })
          await sleep(1500)
          const before = await mean()
          st.maskfirst = 1
          await sleep(150)
          const after = await mean()
          st.maskfirst = 0
          maskFirst = { before: Math.round(before * 1000) / 1000, after: Math.round(after * 1000) / 1000 }
        }
        report[key] = { clean: !dirty, attempts: attempt, battery: battery(), fps: Math.round(fps * 10) / 10, intervalsMs: intervals, flashesPerS: flashes, cook, maskFirst, motion: Object.fromEntries(Object.entries(moved).map(([k, v]) => [k, Math.round(v * 1000) / 10])), frozen: Object.entries(moved).filter(([, v]) => v < 0.005).map(([k]) => k) }
        if (!dirty || attempt === MAX_TRIES) break
        console.error(`${key}: its window was touched (${dirty}); again after 60 s clean`)
        await waitClean()
      }
    }
    // Syphon Out off for 6 s on a slow preset (TouchDesigner's own frame and period; the preview gets no picture): if its
    // frame time drops, publishing waits on the GPU.
    let syphonAB = null
    const ab = presets.findIndex((p) => p.id === 'pointcloud')
    if (ab >= 0 && !only.length) {
      if (busy()) await waitClean()
      dirty = null
      st.run++
      Object.assign(st, { preset: ab, face: 1, drop: 0, pose: 'sweep', syphonoff: 1 })
      await sleep(6000)
      syphonAB = { off: cookOf('pointcloud'), on: report.pointcloud?.cook ?? null, clean: !dirty, battery: battery() }
      st.syphonoff = 0
      // back on, the server may come back under a new uuid: find it again by name (the FIST checks below read the picture)
      for (let k = 0; k < 30; k++) {
        await sleep(100)
        const again = sy.servers().find((s) => s.name === SENDER)
        if (!again) continue
        if (again.uuid !== server.uuid) sy.disconnect(), sy.connect(again.uuid), (server = again)
        break
      }
      await sleep(1000)
    }
    // FIST's host commands: freeze holds the picture, blackout blacks it out (each sent again: back)
    const cmd = (name) => new Promise((r) => sock.send(oscText('/foxbox/cmd', name), PORTS.outPort + 2, '127.0.0.1', r))
    const look = () => back.webContents.executeJavaScript('window.__snap ? window.__snap() : ""')
    const dark = () => back.webContents.executeJavaScript(`(() => { const c = document.querySelector('canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 4000) s += d[i] + d[i + 1] + d[i + 2]; return s / (d.length / 4000) / 3 })()`)
    await cmd('freeze')
    await sleep(600)
    const a = await look()
    await sleep(600)
    const frozen = a === (await look())
    await cmd('freeze')
    await sleep(600)
    const moving = a !== (await look())
    await cmd('blackout')
    await sleep(600)
    const black = await dark()
    await cmd('blackout')
    await sleep(400)
    const commands = { freezeHolds: frozen, unfreezeMoves: moving, blackoutLevel: Math.round(black) }
    clearInterval(pump)
    clearInterval(watch)
    const s = JSON.parse(fs.readFileSync(status, 'utf8'))
    console.log(JSON.stringify({ presets: presets.map((p) => p.id), missing: s.missing, errors: s.errors, running: s.errors_running, fps: s.fps, report, syphonAB, commands, shots: OUT }, null, 1))
  } catch (e) {
    console.log(String(e.message || e))
  } finally {
    clearInterval(feed)
    sy.disconnect()
    sy.unserve()
    // Ours only: the pid our TouchDesigner wrote in status.json (a new pid seen after `open` could be another session's).
    let own = 0
    try {
      own = JSON.parse(fs.readFileSync(status, 'utf8')).pid || 0
    } catch {}
    if (own) {
      try {
        process.kill(own, 'SIGTERM')
      } catch {
        console.log(`our TouchDesigner (pid ${own}) had already quit`)
      }
    }
    else if (pid) console.log(`not quitting pid ${pid}: status.json never named our TouchDesigner`)
    app.quit()
  }
})
