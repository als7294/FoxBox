import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  componentOf,
  COMPONENTS,
  hashComponents,
  listApp,
  readComponentsFile,
  removeParts,
  strayEntry,
  writeComponentsFile,
} from '../../../src/main/components'
import { parseFeed, partsToUpdate } from '../../../src/main/updater'

const h = (c: string) => c.repeat(64)
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

describe('app components', () => {
  it('splits the bundle by path', () => {
    expect(componentOf('Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework')).toBe('electron')
    expect(componentOf('Contents/Frameworks/FoxBox Helper (GPU).app/Contents/Info.plist')).toBe('app') // helpers carry the version
    expect(componentOf('Contents/Resources/engine/runtime/venv/lib/python3.12/site-packages/numpy/__init__.py')).toBe('engine-runtime')
    expect(componentOf('Contents/Resources/engine/code/fvwks_fx/rack.py')).toBe('engine-code')
    expect(componentOf('Contents/Resources/engine/bin/fvwks-engine')).toBe('engine-code')
    expect(componentOf('Contents/Resources/app.asar')).toBe('app')
    expect(componentOf('Contents/_CodeSignature/CodeResources')).toBeNull()
  })

  it('hashes each part from its files, ignoring bytecode, and prunes a copy down to one part', () => {
    const root = mkdtempSync(join(tmpdir(), 'fvwks-comp-'))
    dirs.push(root)
    const app = join(root, 'FoxBox.app')
    const put = (rel: string, body = rel) => {
      mkdirSync(join(app, rel, '..'), { recursive: true })
      writeFileSync(join(app, rel), body)
    }
    put('Contents/Info.plist')
    put('Contents/Resources/engine/code/fvwks_fx/a.py')
    put('Contents/Resources/engine/runtime/venv/x/__pycache__/m.cpython-312.pyc', 'one')
    put('Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework')
    symlinkSync('A', join(app, 'Contents/Frameworks/Electron Framework.framework/Versions/Current'))
    const first = hashComponents(app)
    put('Contents/Resources/engine/runtime/venv/x/__pycache__/m.cpython-312.pyc', 'two')
    expect(hashComponents(app)).toEqual(first)
    put('Contents/Resources/engine/code/fvwks_fx/a.py', 'changed')
    const second = hashComponents(app)
    expect(second['engine-code']).not.toBe(first['engine-code'])
    expect(second['engine-runtime']).toBe(first['engine-runtime'])
    writeComponentsFile(app, second)
    expect(readComponentsFile(app)).toEqual(second)
    expect(hashComponents(app)).toEqual(second) // components.json is not in its own hash
    removeParts(app, (c) => c === 'electron')
    expect(listApp(app).map((e) => e.rel)).toEqual([
      'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework',
      'Contents/Frameworks/Electron Framework.framework/Versions/Current',
    ])
  })

  it('refuses a part zip that reaches outside its part', () => {
    expect(strayEntry(['Contents/', 'Contents/Resources/engine/code/x.py', '__MACOSX/Contents/._x'], 'engine-code')).toBeNull()
    expect(strayEntry(['Contents/Resources/engine/code/x.py', 'Contents/MacOS/FoxBox'], 'engine-code')).toBe('Contents/MacOS/FoxBox')
  })

  it('downloads only the parts whose hash changed', () => {
    const components = COMPONENTS.map((name, i) => ({ name, hash: h(String(i)), url: `${name}.zip`, size: 1000 * (i + 1), sha256: h('a') }))
    const feed = parseFeed(
      {
        version: '1.2.1',
        released: '2026-09-27',
        notes: [],
        files: [{ name: 'FoxBox-1.2.1-arm64.zip', kind: 'zip', size: 9, sha256: h('b') }],
        components,
      },
      'https://github.com/o/r/releases/latest/download/latest-mac.json',
      false,
    )
    expect(feed.components?.[0]?.url).toBe('https://github.com/o/r/releases/latest/download/app.zip')
    const installed = { app: h('9'), electron: h('1'), 'engine-runtime': h('2'), 'engine-code': h('8') }
    expect(partsToUpdate(feed, installed)?.map((p) => p.name)).toEqual(['app', 'engine-code'])
    expect(partsToUpdate(feed, null)).toBeNull()
    expect(
      parseFeed(
        { ...feed, files: [{ name: 'a.zip', kind: 'zip', size: 9, sha256: h('b') }], components: components.slice(1) },
        'https://x.example/f.json',
        false,
      ).components,
    ).toBeNull()
  })
})
