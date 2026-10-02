import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({}))
const { TouchDesignerSession, ourOrphan, rememberOurs, tdPaths } = await import('../../../src/main/bridge/tdSession')
const { datText, readPresets, toeFiles } = await import('../../../src/main/bridge/tdProject')

describe('TouchDesigner as a VISUALS base (1.6)', () => {
  it("writes FoxBox.toe's text form: the network script with this install's ports, run on start", () => {
    const template = readFileSync(join(__dirname, '../../../../touchdesigner/foxbox_setup.py'), 'utf8')
    const files = new Map(toeFiles(template, { enabled: true, host: '127.0.0.1', outPort: 7000, inPort: 7001 }, '/tmp/td/status.json', '2025.33230'))
    const script = (files.get('project1/foxbox_setup.text') as Buffer).subarray(27).toString('utf8')
    expect(script).not.toMatch(/__[A-Z_]+__/)
    expect(script).toContain('IN_PORT = 7000')
    expect(script).toContain('TEXT_PORT = 7002')
    expect(script).toContain('OUT_PORT = 7001')
    expect(script).toContain("STATUS_PATH = r'/tmp/td/status.json'")
    expect(files.get('project1/foxbox_boot.n')).toMatch(/^DAT:execute\n/)
    expect(files.get('project1/foxbox_boot.parm')).toContain('start 0 on')
    expect(files.get('.build')).toContain('build 2025.33230')
  })

  it('reads the presets in order, with their palettes as rgba for TouchDesigner', () => {
    const presets = readPresets(join(__dirname, '../../../../touchdesigner/presets'))
    expect(presets.map((p) => p.id).slice(0, 2)).toEqual(['plexus', 'mosaic'])
    for (const p of presets) {
      expect(p.label.length).toBeLessThanOrEqual(24)
      if (p.build) expect(p.build, p.id).toMatch(/\bout1\b/) // a network: it ends in out1
      else expect(p.frag).toContain('fragColor')
    }
    const template = readFileSync(join(__dirname, '../../../../touchdesigner/foxbox_setup.py'), 'utf8')
    const files = new Map(toeFiles(template, { enabled: true, host: '127.0.0.1', outPort: 7000, inPort: 7001 }, '/s.json', 'b', presets))
    const script = (files.get('project1/foxbox_setup.text') as Buffer).subarray(27).toString('utf8')
    const embedded = JSON.parse(/PRESETS = json\.loads\(r'''(.*)'''\)/.exec(script)![1]!) as { id: string; palette: number[][] }[]
    expect(embedded.map((p) => p.id)).toEqual(presets.map((p) => p.id))
    // A frag.glsl preset's palette goes over as rgba (v3 networks take the named palette instead)
    const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).concat(1)
    const withPalette = presets.findIndex((p) => p.palette.length > 1)
    if (withPalette >= 0) expect(embedded[withPalette]!.palette[1]).toEqual(hex(presets[withPalette]!.palette[1]!))
  })

  // The user's rule for every TouchDesigner effect: it draws on the body and the hands.
  it('every preset declares the body and the hands, and reads both', () => {
    const skipped: string[] = []
    const presets = readPresets(join(__dirname, '../../../../touchdesigner/presets'), (id, why) => skipped.push(`${id}: ${why}`))
    expect(skipped).toEqual([]) // a preset that doesn't read is left out of TouchDesigner: never silently
    expect(presets.length).toBeGreaterThan(0)
    for (const p of presets) {
      expect(p.tracks, p.id).toEqual(expect.arrayContaining(['body', 'hands']))
      const src = p.build || p.frag
      // a shader's accessors, a network's in_* inputs, or the build helpers' parts ('body' / 'hands': skeleton(), instances())
      expect(src, `${p.id} reads the body`).toMatch(/\b(uBody|joint|jointOn|bones|bone|in_body|in_body_pts)\b|['"]body['"]/)
      expect(src, `${p.id} reads the hands`).toMatch(
        /\b(uHands|uHand|handPt|handOn|fingers|nearestHand|uShapeL|uShapeR|uShape|uFrame|frameCorner|frameHeld|inFrame|in_hands|in_hands_pts|in_shapes|in_frame)\b|['"]hands['"]/,
      )
    }
  })

  it('MASK FIRST switching clears every trail and frame stack (no earlier unmasked face lingers)', () => {
    const template = readFileSync(join(__dirname, '../../../../touchdesigner/foxbox_setup.py'), 'utf8')
    const files = new Map(toeFiles(template, { enabled: true, host: '127.0.0.1', outPort: 7000, inPort: 7001 }, '/s.json', 'b', readPresets(join(__dirname, '../../../../touchdesigner/presets'))))
    const script = (files.get('project1/foxbox_setup.text') as Buffer).subarray(27).toString('utf8')
    const activate = /activate\.text = f'''([\s\S]*?)'''/.exec(script)![1]!
    expect(activate).toMatch(/\['maskfirst'\]/) // watched each frame
    expect(activate).toMatch(/findChildren\(type=feedbackTOP\)/) // the trails
    expect(activate).toMatch(/findChildren\(type=texture3dTOP\)/) // SLIT SCAN's frames
    expect(activate).toMatch(/masked != MASKED\[0\]:\s+forget\(\)/) // on a change, either way
  })

  it("binds FoxBox's camera by the name it found, and says so (1.5.2 never bound it)", () => {
    const template = readFileSync(join(__dirname, '../../../../touchdesigner/foxbox_setup.py'), 'utf8')
    const files = new Map(toeFiles(template, { enabled: true, host: '127.0.0.1', outPort: 7000, inPort: 7001 }, '/s.json', 'b', readPresets(join(__dirname, '../../../../touchdesigner/presets'))))
    const script = (files.get('project1/foxbox_setup.text') as Buffer).subarray(27).toString('utf8')
    const finder = /finder\.text = f'''([\s\S]*?)'''/.exec(script)![1]!
    expect(finder).not.toMatch(/\.width/) // an unbound Syphon In has a default size: never proof it's bound
    expect(finder).toMatch(/me\.fetch\('found', None\) == par\.eval\(\)/) // stops asking only once found
    expect(finder).toMatch(/me\.store\('found', want\)/)
    expect(finder).toMatch(/status\['camera'\] = want/) // status.json's camera: the "<app>:<server>" it bound
    expect(script).toMatch(/'\/foxbox\/td_camera', \[1 if found/) // bound, w, h each second, with td_fps
    expect(script).toMatch(/\('maxlines', 20\)/) // the text OSC In DAT capped
    expect(files.get('project1/foxbox_boot.text')?.toString('utf8')).toContain("status['in_text_rows']")
  })

  it("encodes a DAT's text as toeexpand does", () => {
    const b = datText('hé')
    expect(b.subarray(0, 3).toString('latin1')).toBe('2\n*')
    expect([0, 1, 2, 3, 4, 5].map((i) => b.readUInt32BE(3 + i * 4))).toEqual([1, 1, 1, 1, 2, 3])
    expect(b.subarray(27).toString('utf8')).toBe('hé')
  })

  it('quits the TouchDesigner it opened as FoxBox quits (at once), and never another one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'td-quit-'))
    const ours = spawn('/bin/sleep', ['30'], { argv0: 'TouchDesigner' }) // processes named TouchDesigner
    const users = spawn('/bin/sleep', ['30'], { argv0: 'TouchDesigner' })
    try {
      await new Promise((r) => setTimeout(r, 200))
      rememberOurs(dir, ours.pid!)
      expect(ourOrphan(dir)).toBe(ours.pid)
      const quit = vi.fn()
      const conf = { enabled: true, host: '127.0.0.1', outPort: 7000, inPort: 7001 }
      const session = new TouchDesignerSession(
        dir,
        tdPaths(false, '', dir),
        { settings: () => conf, setSettings: () => conf, quit },
        () => [],
        () => {},
      )
      const gone = new Promise((r) => ours.on('exit', r))
      session.stop(true)
      expect(quit).toHaveBeenCalledOnce()
      await gone // SIGTERM at once: no timer outlives the app
      expect(users.exitCode).toBeNull()
      expect(ourOrphan(dir)).toBeNull()
    } finally {
      ours.kill()
      users.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('finds the script and the Syphon addon in Resources when packaged, in the repo in development', () => {
    expect(tdPaths(true, '/R', '/A')).toEqual({
      template: '/R/touchdesigner/foxbox_setup.py',
      presets: '/R/touchdesigner/presets',
      syphon: '/R/syphon_host.node',
    })
    expect(tdPaths(false, '/R', '/repo/app').syphon).toBe('/repo/app/native/syphon/build/syphon_host.node')
  })
})
