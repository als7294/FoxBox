import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { importShaderFiles, listShaders, removeShader, SHADER_MAX_BYTES } from '../../../src/main/shaders'

it('keeps user shaders to plain .fs files inside <data dir>/shaders', () => {
  const root = mkdtempSync(join(tmpdir(), 'shaders-'))
  const dir = join(root, 'shaders')
  const src = join(root, 'picked')
  mkdirSync(src)
  writeFileSync(join(src, 'Glow (v2).fs'), '/*{}*/ void main(){}')
  writeFileSync(join(src, 'big.fs'), 'x'.repeat(SHADER_MAX_BYTES + 1))
  writeFileSync(join(src, 'notes.txt'), 'no')
  writeFileSync(join(root, 'secret.fs'), 'outside')
  expect(importShaderFiles(dir, [join(src, 'Glow (v2).fs'), join(src, 'big.fs'), join(src, 'notes.txt')])).toBe(1)
  symlinkSync(join(root, 'secret.fs'), join(dir, 'link.fs'))
  expect(listShaders(dir).map((s) => s.file)).toEqual(['Glow -v2-.fs']) // the symlink is not listed

  for (const bad of ['../secret.fs', '/etc/hosts', 'link.fs', 'x/../../secret.fs', 42]) expect(removeShader(dir, bad)).toBe(false)
  expect(existsSync(join(root, 'secret.fs'))).toBe(true)
  expect(removeShader(dir, 'Glow -v2-.fs')).toBe(true)
  expect(listShaders(dir)).toEqual([])
})
