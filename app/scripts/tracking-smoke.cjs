// W1's tracking smoke (S1): FoxBox's web build in a hidden window, a generated hand clip as Chromium's fake camera,
// the hand models on the CPU (CI runners have no GPU; --gpu leaves them their GPU). It passes when the hands are found
// in 90% of the run and the plucks are right: within 1 of the clip's truth on the GPU; on the CPU, fewer results a second
// miss some (14 of 16 on an M-series Mac), so at least half of them and never more than 1 extra. No timing gates.
//   npx vite build --config vite.web.config.ts --outDir smoke-web
//   npx electron scripts/tracking-smoke.cjs smoke-web tests/fixtures/hands-c-pose.mjpeg tests/fixtures/hands-c-pose.json
// It reads the SAUCE box's data-hands (hands seen) and data-pluck (each pluck). The fake camera loops the clip in real
// time, so any LOOPS × its length of wall time holds exactly LOOPS × its plucks, whatever the clip's phase.
const { app, BrowserWindow } = require('electron')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const pos = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const [web, clip, truthFile] = pos.slice(-3).map((p) => path.resolve(p))
const gpu = process.argv.includes('--gpu')
// --no-gpu: no hardware acceleration at all (a CI runner's), to reproduce its failures on a Mac
if (process.argv.includes('--no-gpu')) app.disableHardwareAcceleration()
const truth = JSON.parse(fs.readFileSync(truthFile, 'utf8'))
const LOOPS = 2 // counted over the clip twice round, from a second after the first hands
const LAG_MS = 300 // a pluck sounds a little after its fold
const LIMIT_MS = 180_000

app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
app.commandLine.appendSwitch('use-file-for-fake-video-capture', clip)
app.commandLine.appendSwitch('disable-renderer-backgrounding')
// No GPU (a CI runner): MediaPipe needs WebGL to take each frame in, even on its CPU delegate, and Chromium no longer
// falls back to software WebGL by itself. SwiftShader gives it one (FoxBox only ever loads its own pages).
app.commandLine.appendSwitch('enable-unsafe-swiftshader')
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' }
const server = http.createServer((q, r) => {
  const rel = decodeURIComponent(q.url.split('?')[0])
  const f = path.join(web, rel === '/' ? 'index.html' : rel)
  if (!f.startsWith(web)) return r.writeHead(403), r.end()
  fs.readFile(f, (e, d) => (e ? (r.writeHead(404), r.end()) : (r.writeHead(200, { 'content-type': TYPES[path.extname(f)] ?? 'application/octet-stream' }), r.end(d))))
})

const WATCH = `(() => {
  const s = (window.__smoke = { samples: [], plucks: [] })
  const clock = () => performance.now() / 1000
  new MutationObserver((ms) => ms.forEach((m) => m.target.getAttribute('data-pluck') && s.plucks.push(clock()))).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-pluck'] })
  setInterval(() => {
    const box = document.querySelector('[data-hands]')
    s.samples.push([clock(), box ? Number(box.getAttribute('data-hands')) : -1])
  }, 50)
})()`

/** The window: LOOPS × the clip's length from a second after the first hands (null until a run has them). */
function span(run) {
  const first = run.samples.find(([, n]) => n > 0)?.[0]
  return first == null ? null : [first + 1, first + 1 + LOOPS * truth.dur]
}

/** Before the app's own scripts (CDP): the vision worker's URL, its errors and its models; the camera's open or its
 *  error; the page's errors. Printed with the result, so a CI failure says where it stopped. */
const DIAG = `(() => {
  const d = (window.__diag = { workers: [], camera: null, errors: [] })
  const W = window.Worker
  window.Worker = class extends W {
    constructor(url, opts) {
      super(url, opts)
      const rec = { url: String(url).split('/').pop(), events: [] }
      d.workers.push(rec)
      this.addEventListener('error', (e) => rec.events.push('error: ' + (e.message || 'no message')))
      this.addEventListener('messageerror', () => rec.events.push('messageerror'))
      this.addEventListener('message', (e) => {
        const m = e.data || {}
        if (m.type === 'ready' || m.type === 'models') rec.events.push(m.type + ' ' + JSON.stringify(m.delegates || m.ready) + (m.gl === false ? ' NO WEBGL' : ''))
      })
    }
  }
  const md = navigator.mediaDevices
  const gum = md.getUserMedia.bind(md)
  md.getUserMedia = async (c) => {
    try {
      const s = await gum(c)
      const t = s.getVideoTracks()[0]
      d.camera = { ok: true, label: t && t.label, settings: t && t.getSettings() }
      return s
    } catch (e) {
      d.camera = { ok: false, error: e.name + ': ' + e.message }
      throw e
    }
  }
  addEventListener('error', (e) => d.errors.push(String(e.message)))
  addEventListener('unhandledrejection', (e) => d.errors.push('rejection: ' + String((e.reason && e.reason.message) || e.reason)))
})()`

function score(run) {
  const w = span(run)
  if (!w) return { pass: false, why: 'no hands ever seen', models: run.models }
  const [w0, w1] = w
  const inWin = run.samples.filter(([t]) => t >= w0 && t < w1)
  const found = inWin.filter(([, n]) => n >= truth.hands).length / Math.max(1, inWin.length)
  const want = LOOPS * truth.plucks.length
  const got = run.plucks.filter((t) => t >= w0 + LAG_MS / 1000 && t < w1 + LAG_MS / 1000).length
  const models = run.models?.hands ?? null
  const fails = [
    found < 0.9 && `hands found in ${(found * 100).toFixed(1)}% of the run (< 90%)`,
    (gpu ? Math.abs(got - want) > 1 : got < want / 2 || got > want + 1) && `${got} plucks for the truth's ${want}`,
    !gpu && models !== 'CPU' && `the hand model ran on ${models ?? 'nothing'}, not the CPU`,
  ].filter(Boolean)
  return { pass: !fails.length, why: fails.join('; ') || 'ok', handsFound: +found.toFixed(3), plucks: got, truthPlucks: want, seconds: +(w1 - w0).toFixed(1), models: run.models }
}

app.whenReady().then(main).catch((err) => {
  console.log('tracking smoke: failed to run:', err?.message ?? err)
  app.exit(1)
  setTimeout(() => process.exit(1), 2000).unref()
})

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const w = new BrowserWindow({ show: false, width: 1512, height: 982, webPreferences: { offscreen: true, backgroundThrottling: false } })
  w.webContents.setFrameRate(60)
  w.webContents.session.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media'))
  let models = null
  const logs = [] // the page's warnings and errors, and FoxBox's own lines
  const net = [] // the tracker's files: each one's status (or its error)
  const tracker = /vision|\.wasm|\.task|\.tflite/
  w.webContents.session.webRequest.onCompleted((d) => tracker.test(d.url) && net.push(`${d.statusCode} ${d.url.split('/').pop()}`))
  w.webContents.session.webRequest.onErrorOccurred((d) => tracker.test(d.url) && net.push(`${d.error} ${d.url.split('/').pop()}`))
  w.webContents.on('render-process-gone', (_e, d) => logs.push(`renderer gone: ${d.reason}`))
  w.webContents.on('console-message', (e) => {
    const m = String(e.message ?? '')
    if ((e.level === 'warning' || e.level === 'error' || /FoxBox|vision|camera|WebGL/i.test(m)) && logs.length < 25) logs.push(`${e.level}: ${m.slice(0, 200)}`)
    const at = m.indexOf('FoxBox camera models:')
    if (at >= 0) models = JSON.parse(m.slice(at + 'FoxBox camera models:'.length))
  })
  const started = Date.now()
  // The page first (the renderer it ends up in), then DIAG before its scripts on a reload of it.
  await w.loadURL(`http://127.0.0.1:${server.address().port}/${gpu ? '' : '?vision=cpu'}`)
  w.webContents.debugger.attach('1.3')
  await w.webContents.debugger.sendCommand('Page.enable')
  await w.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: DIAG })
  await w.webContents.executeJavaScript("localStorage.setItem('foxbox-setup-done', '1')") // 2.1's first-run setup: done
  await new Promise((r) => (w.webContents.once('did-finish-load', r), w.webContents.reload()))
  await w.webContents.executeJavaScript(WATCH)
  let run = { samples: [], plucks: [] }
  let noGlAt = null
  while (Date.now() - started < LIMIT_MS) {
    await new Promise((r) => setTimeout(r, 500))
    run = await w.webContents.executeJavaScript('window.__smoke')
    const sp = span(run)
    if (sp && (run.samples.at(-1)?.[0] ?? 0) >= sp[1] + LAG_MS / 1000 + 0.2) break
    // no WebGL: no hand will ever be found; give the coach a few seconds, then stop
    if ((await w.webContents.executeJavaScript("JSON.stringify(window.__diag || {}).includes('NO WEBGL')")) && (noGlAt ??= Date.now()) < Date.now() - 4000) break
  }
  const coach = await w.webContents.executeJavaScript(`document.body.innerText.includes("graphics can't run hand tracking")`)
  const result = noGlAt ? { pass: false, why: "no WebGL in the vision worker (no GPU and no software fallback): MediaPipe can't take frames", coach } : score({ ...run, models })
  const diag = await w.webContents.executeJavaScript('window.__diag').catch((e) => ({ unreadable: String(e) }))
  const gpuInfo = await app.getGPUFeatureStatus()
  console.log('tracking smoke:', JSON.stringify(result))
  console.log('tracking smoke diag:', JSON.stringify({ ...diag, webgl2: gpuInfo.webgl2, samples: run.samples.length, boxSeen: run.samples.some(([, n]) => n >= 0), logs, net }))
  app.exit(result.pass ? 0 : 1)
}
