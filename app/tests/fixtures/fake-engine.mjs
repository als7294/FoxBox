#!/usr/bin/env node
// Tiny stand-in for `fvwks-engine`, used to test the supervisor's spawn, health-wait and restart logic.
// Same CLI as the real engine: --port P (0 = pick) [--token T | env FVWKS_TOKEN] --data-dir D [--export-dir E] [--exit-with-parent].
// Prints `FVWKS_ENGINE_READY port=<n>` once listening, like fvwks_server.main.
// Behaviour switches (environment variables):
//   FAKE_ENGINE_DELAY_MS   wait before listening (slow start)
//   FAKE_ENGINE_CRASH_MS   exit(3) this many ms after listening
//   FAKE_ENGINE_CRASH_ONCE crash on the first launch only (marker file in the data dir)
//   FAKE_ENGINE_NEVER_HEALTHY  answer /api/health with 503 forever
//   FAKE_ENGINE_IGNORE_TERM    ignore SIGTERM (forces SIGKILL)
//   FAKE_ENGINE_REQUIRE_FILE   exit(1) at startup unless this file exists (a stale venv: an import fails)
import { createServer } from 'node:http'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const arg = (name) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const port = Number(arg('port') ?? 'NaN')
const token = arg('token') ?? process.env.FVWKS_TOKEN
const dataDir = arg('data-dir')
const exportDir = arg('export-dir') ?? join(dataDir ?? '.', '..', 'exports')
if (!Number.isInteger(port) || !token || !dataDir) {
  console.error('usage: fake-engine --port P [--token T | FVWKS_TOKEN] --data-dir D')
  process.exit(2)
}
mkdirSync(dataDir, { recursive: true })
if (process.env.FAKE_ENGINE_REQUIRE_FILE && !existsSync(process.env.FAKE_ENGINE_REQUIRE_FILE)) {
  console.error('ModuleNotFoundError: No module named mutagen (fake)')
  process.exit(1)
}
if (argv.includes('--exit-with-parent')) {
  process.stdin.on('data', () => {})
  process.stdin.on('end', () => process.exit(0))
  process.stdin.on('error', () => process.exit(0))
}

const env = process.env
const marker = join(dataDir, 'crashed-once')
const crashOnce = env.FAKE_ENGINE_CRASH_ONCE === '1' && !existsSync(marker)
if (crashOnce) writeFileSync(marker, String(Date.now()))

if (env.FAKE_ENGINE_IGNORE_TERM === '1') process.on('SIGTERM', () => console.log('fake-engine: ignoring SIGTERM'))
else process.on('SIGTERM', () => {
  console.log('fake-engine: SIGTERM, bye')
  process.exit(0)
})

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    json(res, 401, { error: { code: 'unauthorized', message: 'missing or wrong token', hint: null } })
    return
  }
  const url = new URL(req.url ?? '/', 'http://x')
  if (url.pathname === '/api/health') {
    if (env.FAKE_ENGINE_NEVER_HEALTHY === '1') json(res, 503, { state: 'starting' })
    else json(res, 200, { state: 'ready', version: '0.0.0-fake', voice_engine: 'fake', fx_engine: 'fake', disk_free_bytes: 1, data_dir: dataDir, export_dir: exportDir, pid: process.pid })
    return
  }
  if (url.pathname === '/api/settings') {
    json(res, 200, { export_dir: exportDir })
    return
  }
  if (url.pathname === '/api/echo') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => json(res, 200, { method: req.method, contentType: req.headers['content-type'] ?? null, body, path: exportDir + '/drop.aiff' }))
    return
  }
  json(res, 404, { error: { code: 'not_found', message: url.pathname, hint: null } })
})

setTimeout(() => {
  server.listen(port, '127.0.0.1', () => {
    const bound = server.address().port
    console.log(`fake-engine listening on ${bound} pid ${process.pid}`)
    console.log(`FVWKS_ENGINE_READY port=${bound}`)
    const crashMs = crashOnce ? 150 : Number(env.FAKE_ENGINE_CRASH_MS ?? 0)
    if (crashMs > 0) setTimeout(() => {
      console.log('fake-engine: crashing')
      process.exit(3)
    }, crashMs)
  })
}, Number(env.FAKE_ENGINE_DELAY_MS ?? 0))
