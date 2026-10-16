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
const truth = JSON.parse(fs.readFileSync(truthFile, 'utf8'))
const LOOPS = 2 // counted over the clip twice round, from a second after the first hands
const LAG_MS = 300 // a pluck sounds a little after its fold
const LIMIT_MS = 180_000

app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
app.commandLine.appendSwitch('use-file-for-fake-video-capture', clip)
app.commandLine.appendSwitch('disable-renderer-backgrounding')
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
})

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const w = new BrowserWindow({ show: false, width: 1512, height: 982, webPreferences: { offscreen: true, backgroundThrottling: false } })
  w.webContents.setFrameRate(60)
  w.webContents.session.setPermissionRequestHandler((_wc, perm, cb) => cb(perm === 'media'))
  let models = null
  w.webContents.on('console-message', (e) => {
    const m = String(e.message ?? '')
    const at = m.indexOf('FoxBox camera models:')
    if (at >= 0) models = JSON.parse(m.slice(at + 'FoxBox camera models:'.length))
  })
  const started = Date.now()
  await w.loadURL(`http://127.0.0.1:${server.address().port}/${gpu ? '' : '?vision=cpu'}`)
  await w.webContents.executeJavaScript(WATCH)
  let run = { samples: [], plucks: [] }
  while (Date.now() - started < LIMIT_MS) {
    await new Promise((r) => setTimeout(r, 500))
    run = await w.webContents.executeJavaScript('window.__smoke')
    const sp = span(run)
    if (sp && (run.samples.at(-1)?.[0] ?? 0) >= sp[1] + LAG_MS / 1000 + 0.2) break
  }
  const result = score({ ...run, models })
  console.log('tracking smoke:', JSON.stringify(result))
  app.exit(result.pass ? 0 : 1)
}
