// node --test ableton/
import assert from 'node:assert/strict'
import { createSocket } from 'node:dgram'
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  addresses,
  amxd,
  deviceStatus,
  devicePatcher,
  findLive,
  installDevice,
  oscMessage,
  parseOsc,
  pickPort,
  readAmxd,
  removeDevice,
  userLibrary,
  userLibraryFromCfg,
} from '../app/src/main/ableton/foxbox-ableton.ts'

const SECRET = '0123456789abcdef0123456789abcdef'
const temp = () => mkdtempSync(join(tmpdir(), 'fb-ableton-'))

test('OSC: the bytes udpreceive decodes, and back', () => {
  const b = oscMessage('/fb/x/midi', [144, 60, 100])
  // "/fb/x/midi" (10) + 2 NUL, ",iii" + 4 NUL, three big-endian int32s
  assert.equal(b.toString('hex'), Buffer.from('/fb/x/midi\0\0,iii\0\0\0\0').toString('hex') + '00000090' + '0000003c' + '00000064')
  assert.deepEqual(parseOsc(b), { address: '/fb/x/midi', args: [144, 60, 100] })
  assert.deepEqual(parseOsc(oscMessage('/fb/x/hello', ['2.1.0'])), { address: '/fb/x/hello', args: ['2.1.0'] })
  assert.equal(oscMessage('/abc', []).length, 12) // "/abc" + 4 NUL, "," + 3 NUL
  // Link: the tempo as float32 (even a whole one), the peer count as int32.
  assert.equal(oscMessage('/fb/x/link', [{ f: 124 }, 2]).toString('latin1', 12, 15), ',fi')
  const link = oscMessage('/fb/x/link', [{ f: 124.5 }, 2])
  assert.equal(link.toString('latin1', 12, 15), ',fi')
  assert.deepEqual(parseOsc(link), { address: '/fb/x/link', args: [124.5, 2] })
  assert.equal(parseOsc(Buffer.from('nope')), null)
})

test('the .amxd: Live\'s unfrozen MIDI effect layout, around the patcher', () => {
  const patcher = devicePatcher({ port: 47400, secret: SECRET })
  const file = amxd(patcher)
  assert.equal(file.toString('latin1', 0, 28).replace(/[^\x20-\x7e]/g, '.'), 'ampf....mmmmmeta........ptch')
  assert.equal(file.readUInt32LE(28), file.length - 32)
  assert.deepEqual(readAmxd(file), JSON.parse(JSON.stringify(patcher)))
  assert.equal(readAmxd(Buffer.from('ampf')), null)
})

test('the patcher: port and secret baked in, every cord on a real inlet and outlet, unique parameters', () => {
  const { patcher } = devicePatcher({ port: 47403, secret: SECRET }) as { patcher: any }
  const texts = patcher.boxes.map((b: any) => b.box.text).filter(Boolean)
  assert.ok(texts.includes('udpreceive 47403'))
  const a = addresses(SECRET)
  assert.ok(texts.includes(`route ${a.midi} ${a.hello} ${a.hands} ${a.link}`))
  assert.ok(texts.includes('sprintf LINK %.1f · %d'))
  assert.ok(texts.includes('midiout') && texts.includes('midiin'))

  const check = (p: any, where: string) => {
    const byId = new Map(p.boxes.map((b: any) => [b.box.id, b.box]))
    for (const { patchline: l } of p.lines) {
      const [src, out] = l.source
      const [dst, inl] = l.destination
      const s: any = byId.get(src)
      const d: any = byId.get(dst)
      assert.ok(s && d, `${where}: cord ${src} → ${dst} names a missing box`)
      assert.ok(out < s.numoutlets, `${where}: ${s.text ?? s.maxclass} has no outlet ${out}`)
      assert.ok(inl < d.numinlets, `${where}: ${d.text ?? d.maxclass} has no inlet ${inl}`)
    }
    for (const b of p.boxes) if (b.box.patcher) check(b.box.patcher, `${where}/${b.box.id}`)
  }
  check(patcher, 'device')

  const names = patcher.boxes.flatMap((b: any) => b.box.saved_attribute_attributes?.valueof?.parameter_longname ?? [])
  assert.deepEqual(names.sort(), [
    'Channel',
    'Height',
    'Height L',
    'Height R',
    'Map Height',
    'Map Shape',
    'Map Spread',
    'Map Twist',
    'Note',
    'Shape',
    'Spread',
    'Twist',
    'Twist L',
    'Twist R',
    'Velocity',
  ])
  // Only the four macros and the channel are saved with a set and automatable; the rest just shows.
  const kept = patcher.boxes.filter((b: any) => b.box.saved_attribute_attributes && !b.box.saved_attribute_attributes.valueof.parameter_invisible)
  assert.deepEqual(kept.map((b: any) => b.box.varname).sort(), ['Channel', 'Height', 'Shape', 'Spread', 'Twist'])
  assert.equal(new Set(names).size, names.length)
  // Everything shown fits Live's device strip (169 px tall).
  for (const b of patcher.boxes) {
    const r = b.box.presentation_rect
    if (r) assert.ok(r[1] + r[3] <= 169 && r[0] + r[2] <= patcher.devicewidth, `${b.box.id} is outside the device`)
  }
})

test('Live: editions, and the User Library from Library.cfg (newest Live first)', () => {
  const apps = temp()
  for (const n of ['Ableton Live 11 Standard.app', 'Ableton Live 12 Suite.app', 'Ableton Live 12 Lite.app', 'Notes.app']) mkdirSync(join(apps, n))
  assert.deepEqual(
    findLive(apps).map((l) => [l.version, l.edition, l.maxForLive]),
    [
      [12, 'Suite', 'yes'],
      [12, 'Lite', 'no'],
      [11, 'Standard', 'add-on'],
    ],
  )
  const cfg = (dir: string, name: string) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<Ableton MajorVersion="5">\n\t<ContentLibrary>\n\t\t<UserLibrary>\n\t\t\t<LibraryProject Id="0">\n\t\t\t\t<ProjectName Value="${name}" />\n\t\t\t\t<ProjectPath Value="${dir}" />\n\t\t\t</LibraryProject>\n\t\t</UserLibrary>\n\t</ContentLibrary>\n</Ableton>\n`
  assert.equal(userLibraryFromCfg(cfg('/Volumes/Sets &amp; More', 'User Library')), '/Volumes/Sets & More/User Library')
  assert.equal(userLibraryFromCfg('<Ableton/>'), null)

  const home = temp()
  assert.equal(userLibrary(home), join(home, 'Music/Ableton/User Library')) // Live never set one up
  for (const [v, dir] of [
    ['Live 12.0.15', '/old'],
    ['Live 12.0.20', '/new'],
    ['Live 9.7.7', '/older'],
  ]) {
    mkdirSync(join(home, 'Library/Preferences/Ableton', v!), { recursive: true })
    writeFileSync(join(home, 'Library/Preferences/Ableton', v!, 'Library.cfg'), cfg(dir!, 'User Library'))
  }
  assert.equal(userLibrary(home), '/new/User Library')
})

test('port: 47400, or the next free one', async () => {
  const base = 47400 + 100 + Math.floor(Math.random() * 400) // clear of a real FoxBox device
  const hold = createSocket('udp4')
  await new Promise<void>((r) => hold.bind(base, '127.0.0.1', () => r()))
  try {
    assert.equal(await pickPort(base), base + 1)
  } finally {
    hold.close()
  }
})

test('install, reinstall (same port and secret), status, remove', async () => {
  const home = temp()
  const library = join(home, 'Lib')
  const where = { userData: join(home, 'fb'), home, library, appsDir: temp() }
  assert.deepEqual(deviceStatus(where), { installed: false, port: null, device: join(library, 'Presets/MIDI Effects/Max MIDI Effect/FoxBox.amxd'), live: [] })
  const first = await installDevice(where)
  assert.equal(first.installed, true)
  const config = JSON.parse(readFileSync(join(where.userData, 'ableton.json'), 'utf8'))
  assert.match(config.secret, /^[0-9a-f]{32}$/)
  assert.equal(config.port, first.port)
  assert.equal(statSync(join(where.userData, 'ableton.json')).mode & 0o777, 0o600)
  const device = readAmxd(readFileSync(first.device)) as any
  assert.ok(device.patcher.boxes.some((b: any) => b.box.text === `udpreceive ${config.port}`))

  await installDevice(where) // a reinstall keeps what a loaded device listens for
  assert.deepEqual(JSON.parse(readFileSync(join(where.userData, 'ableton.json'), 'utf8')), config)

  assert.deepEqual(removeDevice(where), { installed: false, port: null, device: first.device, live: [] })
})
