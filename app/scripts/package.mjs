#!/usr/bin/env node
// Packages FoxBox.app (electron-builder --mac dir, ad-hoc signed).
//   node scripts/package.mjs [--engine-dir <path>] [--install]
// "Linked" build: the app runs <engine-dir>/.venv/bin/fvwks-engine (default: the main checkout's engine/,
// i.e. the repo the coordinator integrates into). Packaged builds ignore FVWKS_ENGINE_DIR/_CMD and FVWKS_UV.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function mainCheckoutEngine() {
  const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: appDir, encoding: 'utf8' }).trim()
  return join(dirname(commonDir), 'engine')
}

const engineDir = resolve(flag('--engine-dir') ?? process.env.FVWKS_LINKED_ENGINE_DIR ?? mainCheckoutEngine())
if (!existsSync(join(engineDir, 'pyproject.toml'))) {
  console.error(`No engine at ${engineDir} (pyproject.toml missing). Pass --engine-dir.`)
  process.exit(1)
}
console.log(`Linked engine: ${engineDir}`)

const { build, Platform } = require('electron-builder')
const config = require(join(appDir, 'electron-builder.config.cjs'))
// electron-builder 26 writes its extraMetadata-merged, stripped package.json over the source one (scripts and
// devDependencies gone). Put the original back whatever happens.
const pkgPath = join(appDir, 'package.json')
const pkgSource = readFileSync(pkgPath, 'utf8')
try {
  await build({
    projectDir: appDir,
    targets: Platform.MAC.createTarget('dir', 3 /* Arch.arm64 */),
    config: { ...config, extraMetadata: { fvwks: { linkedEngineDir: engineDir } } },
    publish: 'never',
  })
} finally {
  if (readFileSync(pkgPath, 'utf8') !== pkgSource) {
    writeFileSync(pkgPath, pkgSource)
    console.log('Restored package.json (electron-builder had rewritten it).')
  }
}

const appPath = join(appDir, 'release', 'mac-arm64', 'FoxBox.app')
execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
const info = execFileSync('codesign', ['-dv', appPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
console.log(`Built ${appPath}`)
console.log(info)

if (args.includes('--install')) {
  execFileSync(process.execPath, [join(appDir, 'scripts', 'install-app.mjs'), appPath], { stdio: 'inherit' })
}
