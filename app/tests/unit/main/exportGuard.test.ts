import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExportGuard } from '../../../src/main/exportGuard'

let dir: string
let root: string
let guard: ExportGuard

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fvwks-guard-'))
  root = join(dir, 'exports')
  mkdirSync(root)
  writeFileSync(join(root, 'drop.aiff'), 'x')
  writeFileSync(join(root, 'drop.txt'), 'x')
  writeFileSync(join(dir, 'secret.aiff'), 'x')
  symlinkSync(join(dir, 'secret.aiff'), join(root, 'link.aiff'))
  guard = new ExportGuard(join(dir, 'roots.json'))
  guard.setRoot(root)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).buffer as ArrayBuffer
const exported = (path: string) => ({ id: 'e1', render_id: 'r1', variant: 'wet', filename: path.split('/').pop(), path })
const exportsResponse = (...paths: string[]) => json({ files: paths.map(exported), warnings: [] })

describe('ExportGuard', () => {
  it('allows only files the engine returned, inside the export root', () => {
    const file = join(root, 'drop.aiff')
    expect(guard.resolveDraggable(file)).toBeNull() // not returned yet
    guard.noteResponse('POST', '/api/exports', exportsResponse(file))
    expect(guard.resolveDraggable(file)).toMatch(/drop\.aiff$/)
  })

  it("takes a REMIX export's Ableton set and rekordbox.xml (v0.11.5), still only inside the root", () => {
    for (const f of ['mix.als', 'rekordbox.xml']) writeFileSync(join(root, f), 'x')
    const result = { remix_id: 'rmx1', files: [exported(join(root, 'drop.aiff'))], warnings: [] }
    guard.noteResponse(
      'GET',
      '/api/remixes/rmx1/export',
      json({ ...result, als_path: join(root, 'mix.als'), rekordbox_xml_path: join(root, 'rekordbox.xml') }),
    )
    expect(guard.resolveDraggable(join(root, 'mix.als'))).toMatch(/mix\.als$/)
    expect(guard.resolveDraggable(join(root, 'rekordbox.xml'))).toMatch(/rekordbox\.xml$/)
    expect(guard.resolveDraggable(join(root, 'drop.aiff'))).toMatch(/drop\.aiff$/)
    guard.noteResponse('GET', '/api/remixes/rmx1/export', json({ ...result, als_path: join(dir, 'secret.aiff') }))
    expect(guard.resolveDraggable(join(dir, 'secret.aiff'))).toBeNull()
  })

  it('refuses paths outside the root, traversal, symlink escapes, other types and junk', () => {
    guard.noteResponse(
      'POST',
      '/api/exports',
      exportsResponse(join(root, '..', 'secret.aiff'), join(root, 'link.aiff'), join(root, 'drop.txt'), join(dir, 'secret.aiff')),
    )
    expect(guard.resolveDraggable(join(root, '..', 'secret.aiff'))).toBeNull()
    expect(guard.resolveDraggable(join(dir, 'secret.aiff'))).toBeNull()
    expect(guard.resolveDraggable(join(root, 'link.aiff'))).toBeNull()
    expect(guard.resolveDraggable(join(root, 'drop.txt'))).toBeNull()
    expect(guard.resolveDraggable(root)).toBeNull()
    expect(guard.resolveDraggable('relative/drop.aiff')).toBeNull()
    expect(guard.resolveDraggable({ path: 'x' })).toBeNull()
    expect(guard.resolveDraggable(`${root}/drop.aiff\0`)).toBeNull()
  })

  it('reveals returned files and the root itself', () => {
    guard.noteResponse('POST', '/api/render', json({ id: 'r1', export: exported(join(root, 'drop.aiff')) }))
    expect(guard.resolveRevealable(join(root, 'drop.aiff'))).toBeTruthy()
    expect(guard.resolveRevealable(root)).toBeTruthy()
    expect(guard.resolveRevealable(dir)).toBeNull()
  })

  it('learns a new root from export_dir in engine responses and remembers old ones', () => {
    const moved = join(dir, 'moved')
    mkdirSync(moved)
    writeFileSync(join(moved, 'new.wav'), 'x')
    guard.noteResponse('GET', '/api/settings', json({ export_dir: moved }))
    guard.noteResponse(
      'GET',
      '/api/library?limit=50',
      json({ items: [{ id: 't1', exports: [exported(join(moved, 'new.wav'))] }], total: 1 }),
    )
    expect(guard.root).toBe(moved)
    expect(guard.resolveDraggable(join(moved, 'new.wav'))).toBeTruthy()
    const reloaded = new ExportGuard(join(dir, 'roots.json'))
    expect(reloaded.roots).toEqual([moved, root])
  })

  it('ignores user-controlled strings and roots from anywhere but health/settings (S3 review)', () => {
    const music = join(dir, 'music')
    mkdirSync(music)
    writeFileSync(join(music, 'private.wav'), 'x')
    // A renderer can make the engine echo arbitrary strings (upload names, titles, scripts)…
    guard.noteResponse('POST', '/api/sources/upload', json({ id: 's1', name: join(music, 'private.wav'), export_dir: music }))
    guard.noteResponse('PATCH', '/api/library/t1', json({ id: 't1', title: join(root, 'drop.aiff'), path: join(root, 'drop.aiff') }))
    expect(guard.roots).not.toContain(music)
    expect(guard.resolveDraggable(join(music, 'private.wav'))).toBeNull()
    expect(guard.resolveDraggable(join(root, 'drop.aiff'))).toBeNull()
    // …but a finished batch names its rekordbox.xml, and a RekordboxResult carries the path.
    writeFileSync(join(root, 'set_rekordbox.xml'), '<x/>')
    guard.noteResponse(
      'GET',
      '/api/jobs/j1',
      json({ id: 'j1', kind: 'batch', state: 'done', message: `5 files · ${join(root, 'set_rekordbox.xml')}` }),
    )
    expect(guard.resolveDraggable(join(root, 'set_rekordbox.xml'))).toBeTruthy()
    guard.noteResponse(
      'POST',
      '/api/exports/rekordbox',
      json({ path: join(root, 'drop.aiff'), filename: 'drop.aiff', tracks: 1, playlist: 'p' }),
    )
    expect(guard.resolveDraggable(join(root, 'drop.aiff'))).toBeTruthy()
  })
})
