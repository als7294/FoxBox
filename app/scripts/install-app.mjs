#!/usr/bin/env node
// Copies the packaged app to ~/Applications (replacing an older copy). ditto keeps signatures and symlinks.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(process.argv[2] ?? join(appDir, 'release', 'mac-arm64', 'FoxBox.app'))
if (!existsSync(source)) {
  console.error(`Nothing to install: ${source} does not exist. Run npm run package first.`)
  process.exit(1)
}
const targetDir = join(homedir(), 'Applications')
const target = join(targetDir, 'FoxBox.app')
mkdirSync(targetDir, { recursive: true })
if (existsSync(target)) rmSync(target, { recursive: true, force: true })
execFileSync('ditto', [source, target], { stdio: 'inherit' })
execFileSync('codesign', ['--verify', '--deep', '--strict', target], { stdio: 'inherit' })
console.log(`Installed ${target}`)
