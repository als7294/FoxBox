#!/usr/bin/env node
// Try the FoxBox device in your own Live before FoxBox 2.1 sends to it: installs FoxBox.amxd into Live's User Library,
// then plays a demo stream for a minute (an A-minor arpeggio, both hands' meters, the four macros).
//   node --no-warnings ableton/try.mjs [seconds]
// Its port and secret are kept in the temp folder (never FoxBox's own settings), so runs reuse them.
import { createSocket } from 'node:dgram'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { addresses, installDevice, oscMessage, readConfig } from '../app/src/main/ableton/foxbox-ableton.ts'

const seconds = Number(process.argv[2] ?? 60)
const userData = join(tmpdir(), 'foxbox-ableton-try')
const status = await installDevice({ userData, home: homedir() })
const { port, secret } = readConfig(userData)
const a = addresses(secret)
const live = status.live[0]
const m4l = { yes: '', 'add-on': ' (needs the Max for Live add-on)', no: " (no Max for Live: the device won't load)" }
console.log(`Installed: ${status.device}`)
console.log(live ? `Live: ${live.edition} ${live.version}${m4l[live.maxForLive]}` : 'Live: not found in /Applications')
console.log(`
In Live: make a MIDI track with a synth on it (Drift is fine). In the browser, open User Library → Presets →
MIDI Effects → Max MIDI Effect and drag FoxBox onto the track, before the synth. Then:
  1. the dot turns green, with "connected", "2 hands" and "LINK 124.0 · 2";
  2. you hear an A-minor arpeggio, NOTE follows it, and the HEIGHT / TWIST meters sway;
  3. Height, Spread and Shape move. Press Map under Height, then click the synth's filter cutoff: it follows;
  4. CH 2 moves the notes to channel 2, and Thru puts them back;
  5. when this stops, the dot goes grey after ~2.5 s, it says "Open FoxBox to connect" and "LINK off".
Sending to 127.0.0.1:${port} for ${seconds} s…`)

const sock = createSocket('udp4')
const send = (address, args) => sock.send(oscMessage(address, args), port, '127.0.0.1')
const notes = [57, 60, 64, 69, 72, 69, 64, 60]
const t0 = Date.now()
let step = 0
send(a.hello, ['try'])
send(a.hands, [2])
// As FoxBox does while Link is on: its tempo and peer count, once a second.
const hello = setInterval(() => {
  send(a.hello, ['try'])
  send(a.link, [{ f: 124 }, 2])
}, 1000)
const arp = setInterval(() => {
  const n = notes[step++ % notes.length]
  send(a.midi, [0x90, n, 100])
  setTimeout(() => send(a.midi, [0x80, n, 0]), 200)
}, 250)
const wave = (t, hz, phase = 0) => Math.round(64 + 60 * Math.sin(2 * Math.PI * hz * t + phase))
const cc = setInterval(() => {
  const t = (Date.now() - t0) / 1000
  const values = [
    [20, wave(t, 0.25)],
    [21, wave(t, 0.25, 1.5)],
    [22, wave(t, 0.4)],
    [23, wave(t, 0.4, 2)],
    [24, wave(t, 0.1)],
    [26, wave(t, 0.15, 1)],
  ]
  for (const [c, v] of values) send(a.midi, [0xb0, c, v])
}, 50)
setTimeout(() => {
  clearInterval(hello)
  clearInterval(arp)
  clearInterval(cc)
  send(a.hands, [0])
  setTimeout(() => {
    sock.close()
    console.log('Done. Run it again any time; installing from FoxBox 2.1 replaces this test copy.')
  }, 300)
}, seconds * 1000)
