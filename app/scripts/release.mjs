#!/usr/bin/env node
// Builds a FoxBox release. It never publishes anything: attach the files it prints to a GitHub release yourself.
//   node scripts/release.mjs <patch|minor|major|x.y.z|--no-bump> [--notes "line"]... [--notes-file <file>]
//   e.g. node scripts/release.mjs 1.0.0 --notes-file release-notes/1.0.0.md   (release-notes/<version>.md is used
//   automatically when no notes are given)
//
// 1. Sets the version in package.json and package-lock.json (commit that yourself).
// 2. Builds the renderer/main (electron-vite) and the bundled-engine app: release/<version>/FoxBox-<version>-arm64.dmg
//    for first installs and FoxBox-<version>-arm64.zip for in-app updates.
// 3. Writes release/<version>/latest-mac.json, the update feed the app reads from the latest GitHub release:
//    { version, released, notes[], files: [{ name, kind: 'zip' | 'dmg', size, sha256 }] }.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const all = (name) => args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1]] : []))
const one = (name) => all(name)[0]

const pkgPath = join(appDir, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const bumpArg = args[0] && !args[0].startsWith('--') ? args[0] : null
if (!bumpArg && !args.includes('--no-bump')) {
  console.error('usage: node scripts/release.mjs <patch|minor|major|x.y.z|--no-bump> [--notes "line"]... [--notes-file <file>]')
  process.exit(1)
}

function bump(v, how) {
  if (/^\d+\.\d+\.\d+$/.test(how)) return how
  const [maj, min, pat] = v.split('.').map(Number)
  if (how === 'major') return `${maj + 1}.0.0`
  if (how === 'minor') return `${maj}.${min + 1}.0`
  if (how === 'patch') return `${maj}.${min}.${pat + 1}`
  throw new Error(`Unknown bump "${how}" (patch, minor, major or x.y.z)`)
}

const version = bumpArg ? bump(pkg.version, bumpArg) : pkg.version
if (version !== pkg.version) {
  // Edit the version fields in place so the files keep their formatting.
  const setVersion = (file, count) => {
    const path = join(appDir, file)
    let text = readFileSync(path, 'utf8')
    let n = 0
    text = text.replace(/("version":\s*")[^"]+(")/g, (m, a, b) => (n++ < count ? `${a}${version}${b}` : m))
    writeFileSync(path, text)
  }
  setVersion('package.json', 1)
  setVersion('package-lock.json', 2) // the lockfile's own version and packages[""].version
  console.log(`Version ${pkg.version} → ${version}`)
}

const notes = [...all('--notes')]
const defaultNotes = join(appDir, 'release-notes', `${version}.md`)
const notesFile = one('--notes-file') ?? (notes.length === 0 && existsSync(defaultNotes) ? defaultNotes : undefined)
if (notesFile) notes.push(...readFileSync(resolve(notesFile), 'utf8').split('\n').map((l) => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean))

if (!existsSync(join(appDir, 'credit.local.json')) && !process.env.FVWKS_CREDIT_EMAIL) {
  console.warn('Note: no credit.local.json or FVWKS_CREDIT_EMAIL, so the credit ships as plain text (no mail link).')
}

const outDir = join(appDir, 'release', version)
execFileSync('npx', ['electron-vite', 'build'], { cwd: appDir, stdio: 'inherit' })
execFileSync(process.execPath, [join(appDir, 'scripts', 'package.mjs'), '--bundle-engine', '--dmg', '--out', outDir], { cwd: appDir, stdio: 'inherit' })

const sha256 = (file) =>
  new Promise((ok, fail) => {
    const h = createHash('sha256')
    createReadStream(file).on('data', (c) => h.update(c)).on('error', fail).on('end', () => ok(h.digest('hex')))
  })

const files = []
for (const kind of ['zip', 'dmg']) {
  const name = `${pkg.productName}-${version}-arm64.${kind}`
  const path = join(outDir, name)
  if (!existsSync(path)) throw new Error(`Missing ${path}`)
  files.push({ name, kind, size: statSync(path).size, sha256: await sha256(path) })
}
const feed = { version, released: new Date().toISOString().slice(0, 10), notes, files }
const feedPath = join(outDir, 'latest-mac.json')
writeFileSync(feedPath, `${JSON.stringify(feed, null, 2)}\n`)

const updates = readFileSync(join(appDir, 'src', 'shared', 'updates.ts'), 'utf8')
const repo = /DEFAULT_UPDATE_REPO\s*=\s*'([^']+)'/.exec(updates)?.[1] ?? '<owner>/<repo>'
console.log(`\nRelease ${version} is ready in ${outDir}:`)
for (const f of files) console.log(`  ${f.name}  ${(f.size / 1e6).toFixed(1)} MB  sha256 ${f.sha256}`)
console.log(`  latest-mac.json`)
console.log(`\nPublish it (not done here), e.g.:`)
console.log(`  gh release create v${version} --repo ${repo} --title "FoxBox ${version}" \\`)
console.log(`    ${files.map((f) => JSON.stringify(join(outDir, f.name))).join(' ')} ${JSON.stringify(feedPath)}`)
