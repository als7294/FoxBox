// FoxBox.toe without a Textport step (1.6): the project as TouchDesigner's own text form (the layout its toeexpand
// writes and its toecollapse reads: one .n and .parm per operator, DAT text as .text), collapsed by the user's own
// TouchDesigner. Ours is tiny: /project1 with an Execute DAT that, on start, runs foxbox_setup.py (a Text DAT) to build
// the network fresh, then writes the status file FoxBox waits for. Checked against TouchDesigner 2025.33230: it
// round-trips through toeexpand byte for byte, launches hidden with no sign-in window, builds with no errors and
// cooks at 62 fps hidden.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { TdSettings } from '../../shared/bridge'
import { TD_GESTURE_ACTIONS, type TdGestureDefaults, type TdPreset } from '../../shared/tdPresets'
import { tdSender, textPort } from './touchdesigner'

/** A DAT's text as toeexpand writes it: "2\n*", five int32 (1, 1, 1, 1, 2), the byte length, the UTF-8 text. */
export function datText(text: string): Buffer {
  const body = Buffer.from(text, 'utf8')
  const head = Buffer.alloc(3 + 24)
  head.write('2\n*', 0, 'latin1')
  ;[1, 1, 1, 1, 2, body.length].forEach((n, i) => head.writeUInt32BE(n, 3 + i * 4))
  return Buffer.concat([head, body])
}

const BOOT = (status: string) => `# FoxBox: build the network on start (foxbox_setup), then add the cook rate a few seconds in.
import json, os, time, traceback

STATUS = r'${status}'

def onStart():
    # its pid first thing (a plain write): opening a project shows its editor window even from a hidden launch, and
    # FoxBox hides it by this pid at once (tdSession.ts)
    with open(os.path.join(os.path.dirname(STATUS), 'booting.json'), 'w') as f:
        json.dump({'pid': os.getpid(), 'at': time.time()}, f)
    try:
        exec(op('/project1/foxbox_setup').text, globals())
    except Exception:
        with open(STATUS, 'w') as f:
            json.dump({'ok': False, 'error': traceback.format_exc(), 'built_at': time.time(), 'pid': os.getpid()}, f)
        return
    me.store('t0', (absTime.frame, time.time()))
    run("me.module.measure()", fromOP=me, delayFrames=300)
    return

def measure():
    f0, t0 = me.fetch('t0')
    with open(STATUS) as f:
        status = json.load(f)
    status['fps'] = round((absTime.frame - f0) / max(1e-6, time.time() - t0), 1)
    me.store('t0', (absTime.frame, time.time()))  # and again every 5 s: its cook rate, as it runs
    run("me.module.measure()", fromOP=me, delayFrames=300)
    box = op('/project1/foxbox')
    status['errors_running'] = [o.path + ': ' + o.errors() for o in box.findChildren() if o.errors()] if box else []
    text = op('/project1/foxbox/in_text')
    status['in_text_rows'] = text.numRows if text else None  # capped at 20 (a set-long OSC In DAT grows otherwise)
    with open(STATUS, 'w') as f:
        json.dump(status, f)
`

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const rgba = (hex: string): number[] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  const n = m ? parseInt(m[1]!, 16) : 0
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, 1]
}

/** A preset's source: a TouchDesigner network (`build`, v3: build.py) or one fragment shader (`frag`, v1-2). */
export type TdPresetSource = TdPreset & { frag: string; build: string }

/** preset.json's `gestures`, kept only where a key and its value are known (anything else is dropped). */
function gesturesOf(raw: unknown): Partial<TdGestureDefaults> {
  const out: Partial<Record<keyof TdGestureDefaults, string>> = {}
  if (raw && typeof raw === 'object')
    for (const [k, allowed] of Object.entries(TD_GESTURE_ACTIONS) as [keyof TdGestureDefaults, readonly string[]][]) {
      const v = (raw as Record<string, unknown>)[k]
      if (typeof v === 'string' && allowed.includes(v)) out[k] = v
    }
  return out as Partial<TdGestureDefaults>
}

/** touchdesigner/presets/<id>/ (preset.json + build.py, or + frag.glsl), in order; a folder that doesn't read is
 *  skipped (`bad`). */
export function readPresets(dir: string, bad: (id: string, why: string) => void = () => {}): TdPresetSource[] {
  if (!existsSync(dir)) return []
  const out: TdPresetSource[] = []
  for (const id of readdirSync(dir).sort()) {
    if (!/^[a-z0-9_-]{1,32}$/.test(id) || !existsSync(join(dir, id, 'preset.json'))) continue
    try {
      const j = JSON.parse(readFileSync(join(dir, id, 'preset.json'), 'utf8')) as Partial<TdPreset>
      const read = (f: string) => (existsSync(join(dir, id, f)) ? readFileSync(join(dir, id, f), 'utf8') : '')
      const build = read('build.py')
      const frag = build ? '' : readFileSync(join(dir, id, 'frag.glsl'), 'utf8')
      if (frag.includes("'''") || build.includes("'''")) throw new Error("its source can't contain ''' (use \"\"\")")
      out.push({
        id,
        label: String(j.label ?? id.toUpperCase()).slice(0, 24),
        title: String(j.title ?? ''),
        how: String(j.how ?? '').slice(0, 60),
        order: num(j.order, 100),
        tracks: (Array.isArray(j.tracks) ? j.tracks : []).map(String),
        mode: j.mode === 'hands' ? 'hands' : 'body',
        macros: (Array.isArray(j.macros) ? j.macros : []).slice(0, 4).map((m, i) => ({
          id: String(m?.id ?? `m${i}`),
          label: String(m?.label ?? m?.id ?? `M${i + 1}`),
          default: Math.min(1, Math.max(0, num(m?.default, 0.5))),
        })),
        reacts_to: String(j.reacts_to ?? 'kick'),
        palette: (Array.isArray(j.palette) ? j.palette : []).slice(0, 4).map(String),
        feedback: j.feedback === true,
        sound: j.sound && typeof j.sound === 'object' ? j.sound : null,
        gestures: gesturesOf(j.gestures),
        new: j.new === true,
        frag,
        build,
      })
    } catch (e) {
      bad(id, e instanceof Error ? e.message : String(e))
    }
  }
  return out.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
}

/** The text form's files (relative path → content), in the order its .toc lists them. */
export function toeFiles(
  setupTemplate: string,
  settings: TdSettings,
  statusPath: string,
  build: string,
  presets: TdPresetSource[] = [],
): [string, string | Buffer][] {
  const forTd = presets.map((p) => ({ id: p.id, frag: p.frag, build: p.build, feedback: p.feedback, palette: p.palette.map(rgba) }))
  const setup = setupTemplate
    .replaceAll('__PRESETS__', JSON.stringify(forTd))
    .replaceAll('__IN_PORT__', String(settings.outPort))
    .replaceAll('__TEXT_PORT__', String(textPort(settings)))
    .replaceAll('__SENDER__', tdSender(settings))
    .replaceAll('__OUT_PORT__', String(settings.inPort))
    .replaceAll('__STATUS_PATH__', statusPath)
  return [
    ['.build', `version 099\nbuild ${build}\ntime ${new Date().toUTCString()}\n`],
    ['.start', 'cookrate 60\nclock -f 1 -s 1 -o 0 -w 0\nrealtime on\nviewers off\n'],
    ['.grps', '-2\n0\n'],
    ['project1.n', 'COMP:container\ntile 0 0 400 244\nflags =  viewer 1 parlanguage 0\nend\n'],
    ['project1.parm', '?\nw 0 1280\nh 0 720\n?\n'],
    ['project1/foxbox_setup.n', 'DAT:text\ntile 0 -200 160 130\nflags =  viewer 1 parlanguage 0\nend\n'],
    ['project1/foxbox_setup.text', datText(setup)],
    ['project1/foxbox_boot.n', 'DAT:execute\ntile 200 -200 130 101\nflags =  viewer 1 parlanguage 0\nend\n'],
    ['project1/foxbox_boot.parm', '?\nstart 0 on\nlanguage 0 python\n?\n'],
    ['project1/foxbox_boot.text', datText(BOOT(statusPath))],
    ['perform.n', 'COMP:window\ntile -200 40 160 130\nflags =  viewer 1 parlanguage 0\nend\n'],
    ['perform.parm', '?\nwinop 0 project1\n?\n'],
    ['.application', 'winplacement ontop=0 mode=auto posx=0 posy=0 sizex=320 sizey=180 enable=1 perform.path=/perform\n'],
  ]
}

/** Writes FoxBox.toe's text form into `dir` and collapses it with the user's toecollapse. Resolves FoxBox.toe's path. */
export async function buildToe(appPath: string, dir: string, files: [string, string | Buffer][]): Promise<string> {
  const toe = join(dir, 'FoxBox.toe')
  rmSync(`${toe}.dir`, { recursive: true, force: true })
  for (const [rel, content] of files) {
    const path = join(`${toe}.dir`, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  writeFileSync(`${toe}.toc`, files.map(([rel]) => `${rel}\n`).join(''))
  rmSync(toe, { force: true })
  await new Promise<void>((resolve, reject) =>
    execFile(join(appPath, 'Contents', 'MacOS', 'toecollapse'), [toe], { timeout: 20000 }, (err, _out, stderr) =>
      err
        ? reject(
            new Error(
              `toecollapse: ${String(stderr || err.message)
                .trim()
                .slice(0, 200)}`,
            ),
          )
        : resolve(),
    ),
  )
  return toe
}
