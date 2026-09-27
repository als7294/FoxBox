#!/usr/bin/env node
// Packages FoxBox.app with electron-builder (arm64, ad-hoc signed).
//   node scripts/package.mjs [--engine-dir <path>] [--install]            linked build (this Mac)
//   node scripts/package.mjs --bundle-engine [--dmg] [--out <dir>]         self-contained build (any Mac, macOS 14+)
//
// Linked: the app runs <engine-dir>/.venv/bin/fvwks-engine (default: the main checkout's engine/, i.e. the repo the
// coordinator integrates into); `--install` copies it to ~/Applications.
// Bundled: engine/server/scripts/bundle_engine.sh builds a portable engine (CPython + locked venv, ~0.8 GB) that
// ships at Contents/Resources/engine; the app launches it with no uv and keeps models under its data folder. The app
// never learns this checkout's path. `--dmg` also makes FoxBox-<version>-arm64.dmg (first installs) and
// FoxBox-<version>-arm64.zip (updates, made with ditto so the bundle's symlinks survive).
// Packaged builds ignore FVWKS_ENGINE_DIR/_CMD and FVWKS_UV.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const bundled = args.includes('--bundle-engine')
const dmg = args.includes('--dmg')
const outDir = resolve(appDir, flag('--out') ?? 'release')
if (dmg && !bundled) {
  console.error('--dmg ships to other Macs, so it needs --bundle-engine (a linked build only runs on this Mac).')
  process.exit(1)
}

const repoDir = () => {
  const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: appDir, encoding: 'utf8' }).trim()
  return dirname(commonDir)
}

const pkgPath = join(appDir, 'package.json')
const pkgSource = readFileSync(pkgPath, 'utf8')
const { productName, version } = JSON.parse(pkgSource)
const config = require(join(appDir, 'electron-builder.config.cjs'))
let extra = {}

if (bundled) {
  // This checkout's engine (the one the tests ran against), bundled into release/, which is git-ignored.
  const script = resolve(appDir, '..', 'engine', 'server', 'scripts', 'bundle_engine.sh')
  const bundleDir = join(outDir, '.engine-bundle')
  mkdirSync(outDir, { recursive: true })
  console.log(`Bundling the engine into ${bundleDir} …`)
  execFileSync('bash', [script, bundleDir], { stdio: 'inherit' })
  if (!existsSync(join(bundleDir, '.fvwks-engine-bundle')) || !existsSync(join(bundleDir, 'bin', 'fvwks-engine'))) {
    console.error(`bundle_engine.sh did not produce an engine bundle in ${bundleDir}`)
    process.exit(1)
  }
  extra = { extraResources: [{ from: bundleDir, to: 'engine', filter: ['**/*'] }] }
} else {
  const engineDir = resolve(flag('--engine-dir') ?? process.env.FVWKS_LINKED_ENGINE_DIR ?? join(repoDir(), 'engine'))
  if (!existsSync(join(engineDir, 'pyproject.toml'))) {
    console.error(`No engine at ${engineDir} (pyproject.toml missing). Pass --engine-dir.`)
    process.exit(1)
  }
  console.log(`Linked engine: ${engineDir}`)
  extra = { extraMetadata: { fvwks: { linkedEngineDir: engineDir } } }
}

const { build, Platform } = require('electron-builder')
// electron-builder 26 writes its extraMetadata-merged, stripped package.json over the source one (scripts and
// devDependencies gone). Put the original back whatever happens.
try {
  await build({
    projectDir: appDir,
    targets: Platform.MAC.createTarget(dmg ? 'dmg' : 'dir', 3 /* Arch.arm64 */),
    config: { ...config, ...extra, directories: { ...config.directories, output: outDir } },
    publish: 'never',
  })
} finally {
  if (readFileSync(pkgPath, 'utf8') !== pkgSource) {
    writeFileSync(pkgPath, pkgSource)
    console.log('Restored package.json (electron-builder had rewritten it).')
  }
}

const appPath = join(outDir, 'mac-arm64', `${productName}.app`)
execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
const info = execFileSync('codesign', ['-dv', appPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
console.log(`Built ${appPath}`)
console.log(info)

if (dmg) {
  // The update archive: ditto keeps the framework symlinks and extended attributes that a plain zip can lose.
  const zip = join(outDir, `${productName}-${version}-arm64.zip`)
  rmSync(zip, { force: true })
  execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zip], { stdio: 'inherit' })
  console.log(`Built ${zip}`)
}

if (args.includes('--install')) {
  if (bundled) console.warn('Note: installing a bundled build; it keeps its models under its own data folder.')
  execFileSync(process.execPath, [join(appDir, 'scripts', 'install-app.mjs'), appPath], { stdio: 'inherit' })
}
