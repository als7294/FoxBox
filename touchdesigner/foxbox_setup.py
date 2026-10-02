"""FoxBox's TouchDesigner network (1.6, the free route). FoxBox never asks you to run this: it writes a tiny FoxBox.toe
(as TouchDesigner's text form, collapsed by your own TouchDesigner's toecollapse) whose Execute DAT runs this script on
start. Each launch it builds /project1/foxbox fresh, switches to perform mode, and writes STATUS_PATH (JSON) so
FoxBox knows it's up: the TouchDesigner version, the errors, any parameter this TouchDesigner build doesn't have, and
the cook rate a few seconds in (is a hidden TouchDesigner slowed down?).

  in_foxbox  OSC In CHOP on IN_PORT: FoxBox's channels (/foxbox/kick, /bpm, ...), renamed to plain names in `ch`
  in_text    OSC In DAT on TEXT_PORT: the word, the section, the preset, and /foxbox/quit
  out_foxbox OSC Out DAT to FoxBox (OUT_PORT): macros and presets back, as in the 1.3 bridge
  camera     Syphon Spout In TOP: FoxBox's camera ("FoxBox Camera", found by camera_finder), always on while the base
             is TOUCHDESIGNER
  points, body, hands, frame, shapes   Script CHOPs: the person FoxBox tracks (face, body, hands, the hands'
             shapes; OSC from renderer/touchdesigner/camera.ts) as arrays for the shaders, eased per frame
  p_<id>     a preset: a Base COMP whose network its presets/<id>/build.py builds (v3: TouchDesigner operators on the
             standard in_* inputs, into its out1 TOP; only the one showing cooks), or for a v1-2 preset a GLSL TOP
             (presets/<id>/frag.glsl after HEADER; a Feedback TOP into its second input when it asks for "feedback")
  scr_*, cam_fit, matte   v3's shared inputs: the tracking in screen space, the camera fitted to the picture, the
             person matte (see network() and presets/README.md)
  look       the preset FoxBox picked (/foxbox/td_preset), into a Syphon Spout Out TOP named FoxBox, 1280 x 720
             (TouchDesigner's free licence caps the picture at 1280 x 1280)

Everything here is FoxBox's own (GPL-3.0); it uses stock operators only.
"""

import json
import os
import time
import traceback

IN_PORT = __IN_PORT__  # FoxBox → TouchDesigner: the channels (numbers)
TEXT_PORT = __TEXT_PORT__  # FoxBox → TouchDesigner: text and control (an OSC In CHOP and DAT can't share a port)
OUT_PORT = __OUT_PORT__  # TouchDesigner → FoxBox
STATUS_PATH = r'__STATUS_PATH__'
SENDER = '__SENDER__'  # FoxBox's name for this picture ("FoxBox", or "FoxBox <port>" on other ports)
W, H = 1280, 720

root = op('/project1')
old = root.op('foxbox')
if old is not None:
    old.destroy()
box = root.create(baseCOMP, 'foxbox')
box.nodeX, box.nodeY = 0, -300


def place(node, x, y):
    node.nodeX, node.nodeY = x * 200, -y * 150
    return node


MISSING = []  # parameters this TouchDesigner build doesn't have (for FoxBox's status)


def setp(node, name, value, expr=False):
    """Set a parameter if this TouchDesigner build has it (names drift between versions); note it if not."""
    par = getattr(node.par, name, None)
    if par is None:
        MISSING.append(f'{node.path}.{name}')
        return
    try:
        if expr:
            par.expr = value
            par.mode = ParMode.EXPRESSION
        else:
            par.val = value
    except Exception as e:  # a menu entry this build doesn't have
        MISSING.append(f'{node.path}.{name}={value!r}: {e}')


osc_in = place(box.create(oscinCHOP, 'in_foxbox'), 0, 0)
setp(osc_in, 'port', IN_PORT)
ch = place(box.create(renameCHOP, 'ch'), 1, 0)  # foxbox/kick -> kick
ch.inputConnectors[0].connect(osc_in)
setp(ch, 'renamefrom', 'foxbox/*')
setp(ch, 'renameto', '*')

callbacks = place(box.create(textDAT, 'in_text_callbacks'), 0, 2)
callbacks.text = '''
def command(name, args):
    # FoxBox's gesture commands (/foxbox/cmd <name> [x y w h], the picture's 0-1, y down): freeze and blackout here
    # for every preset (again: back), the rest to the preset showing, if its build.py made an on_cmd DAT
    state = op('cmd_state')
    if name in ('freeze', 'blackout'):
        state[name, 1] = '0' if state[name, 1].val == '1' else '1'
        if name == 'freeze':  # the picture held by locking the look switch: no copy each frame, the preset not cooked
            op('look').lock = state[name, 1].val == '1'
        return
    ids = op('preset_ids')
    i = int(op('ch')['td_preset'] or 0)
    target = op('p_' + ids[i, 0].val) if i < ids.numRows else None
    handler = target.op('on_cmd') if target is not None else None
    if handler is not None:
        try:
            handler.module.onCommand(name, args)
        except Exception as e:
            debug('on_cmd', name, e)

def onReceiveOSC(dat, rowIndex, message, byteData, timeStamp, address, args, peer):
    if address == '/foxbox/quit':
        project.quit(force=True)  # FoxBox turned TouchDesigner off
        return
    if address == '/foxbox/cmd' and args:
        command(str(args[0]), [float(a) for a in args[1:] if isinstance(a, (int, float))])
        return
    if args and address.startswith('/foxbox/'):
        table = op('text')
        key = address[len('/foxbox/'):]
        if table.row(key) is None:
            table.appendRow([key, str(args[0])])
        else:
            table[key, 1] = str(args[0])
'''
text = place(box.create(tableDAT, 'text'), 1, 2)
text.clear()
osc_text = place(box.create(oscinDAT, 'in_text'), 0, 1)
setp(osc_text, 'port', TEXT_PORT)
setp(osc_text, 'callbacks', callbacks.name)
# its rows capped (the callbacks keep what matters in `text`): unclamped, an OSC In DAT grows all set long (S3)
for name, value in (('clamp', True), ('maxlines', 20)):
    if hasattr(osc_text.par, name):
        setp(osc_text, name, value)

osc_out = place(box.create(oscoutDAT, 'out_foxbox'), 0, 3)
for p in ('netaddress', 'address'):  # "Network Address" (its name differs between TouchDesigner builds)
    if hasattr(osc_out.par, p):
        setp(osc_out, p, '127.0.0.1')
        break
setp(osc_out, 'port', OUT_PORT)


def channel(name):
    return f"(op('ch')['{name}'] or 0)"


CAMERA = SENDER + ' Camera'  # FoxBox's Syphon server (native/syphon serve/publish)
NPTS = 32  # landmark slots; FoxBox sends up to this many

camera = place(box.create(syphonspoutinTOP, 'camera'), 2, 0)
setp(camera, 'sendername', CAMERA)
# TouchDesigner lists another app's server as "<app>:<server>" (FoxBox's app name differs between builds): this picks
# FoxBox's camera whenever it appears, twice a second.
finder = place(box.create(executeDAT, 'camera_finder'), 2, -1)
finder.text = f'''
import json

def onFrameStart(frame):
    if frame % 30:
        return
    par = op('camera').par.sendername
    if me.fetch('found', None) == par.eval():
        return  # found before: no need to ask Syphon's directory again (menuNames lists every server). Not the
        # width: an unconnected Syphon In has a default size, so the bare name we start on looked found and the
        # camera never connected (1.5.2)
    want = next((n for n in par.menuNames if n == {CAMERA!r} or n.endswith(':' + {CAMERA!r})), None)
    if want:
        if par.eval() != want:
            par.val = want
        me.store('found', want)
        try:  # the server it bound to, for FoxBox's checks (status.json's camera)
            with open(r'{STATUS_PATH}') as f:
                status = json.load(f)
            status['camera'] = want
            with open(r'{STATUS_PATH}', 'w') as f:
                json.dump(status, f)
        except Exception:
            pass
    return
'''
setp(finder, 'framestart', True)
# Its own cook rate to FoxBox each second (/foxbox/td_fps, for main.log's [TD] line: is TouchDesigner itself slow?)
cook_report = place(box.create(executeDAT, 'cook_report'), 2, -1.6)
cook_report.text = '''
import time
def onFrameStart(frame):
    t, f = me.fetch('t', None), me.fetch('f', None)
    now = time.time()
    if t is None or now - t >= 1.0:
        if t is not None:
            op('out_foxbox').sendOSC('/foxbox/td_fps', [(frame - f) / (now - t)])
            cam = op('camera')  # bound: the finder found FoxBox's camera and is on it
            found = op('camera_finder').fetch('found', None)
            op('out_foxbox').sendOSC('/foxbox/td_camera', [1 if found and cam.par.sendername.eval() == found else 0, cam.width, cam.height])
        me.store('t', now)
        me.store('f', frame)
    return
'''
setp(cook_report, 'framestart', True)
# Syphon between FoxBox and TouchDesigner flips the picture each way: upright here, and again on the way out (look_up),
# so what TouchDesigner draws (the windows' title bars, the numbers, the landmarks on the face) is upright in FoxBox.
camera_up = place(box.create(flipTOP, 'camera_up'), 3, 0)
camera_up.inputConnectors[0].connect(camera)
setp(camera_up, 'flipy', True)

# The tracking (FoxBox's OSC: renderer/touchdesigner/camera.ts) as arrays for the shaders, eased per frame (hands and
# the body arrive at 10-15 Hz: unsmoothed, a stroke drawn with a fingertip comes out dotted), snapping when one appears:
#   points  the face's landmarks (pt<i>x/y, i < npts)        32 x (x, y)
#   body    BlazePose's 33 (b<i>x/y/v, i < nbody)             33 x (x, y, visibility)
#   hands   left 0-20, right 21-41 (hl<i>x/y, hr<i>x/y; hlon, hron)   42 x (x, y)
#   frame   the FRAME's corners (f<i>x/y, i < 4, while fheld)  4 x (x, y)
#   shapes  one sample: the hands' on, gesture, pinch, open, fingers; apart, FRAME size and held, triangle
# Off is x = -1. All in the camera frame, 0-1, y down. The presets see only the uniforms built from these, so another
# tracker could feed them instead.
track_callbacks = place(box.create(textDAT, 'track_callbacks'), 1, 1)
track_callbacks.text = '''
EASE = {'shapes': 0.35}  # the points come One Euro-filtered (smooth_*); the shapes' values are eased here
SNAP = ('hlon', 'hron', 'hlgest', 'hrgest', 'triangle')  # flags: never eased
FADE = {'fheld': 0.25}  # FRAME held fades in and out (a portal never pops); its corners stay until it's gone
SHAPES = ('hlon', 'hron', 'hlgest', 'hrgest', 'hlpinch', 'hlopen', 'hlfingers', 'hrpinch', 'hropen', 'hrfingers',
          'apart', 'fsize', 'triangle', 'fheld', 'hltwist', 'hrtwist')

def rows(ch, name, smooth=None):
    def v(c):  # flags and counts: as sent
        x = ch.chan(c)
        return x[0] if x is not None else None
    def p(c):  # a point's coordinate: One Euro-filtered when there's a filter
        x = smooth.chan(c) if smooth is not None else None
        return x[0] if x is not None else v(c)
    if name == 'points':
        n = int(v('npts') or 0)
        return [[p('pt%dx' % i), p('pt%dy' % i)] if i < n else None for i in range(32)]
    if name == 'body':
        n = int(v('nbody') or 0)
        return [[p('b%dx' % i), p('b%dy' % i), v('b%dv' % i)] if i < n else None for i in range(33)]
    if name == 'hands':
        out = []
        for side in 'lr':
            on = (v('h%son' % side) or 0) > 0.5
            out += [[p('h%s%dx' % (side, i)), p('h%s%dy' % (side, i))] if on else None for i in range(21)]
        return out
    if name == 'frame':
        held = (v('fheld') or 0) > 0.5
        return [[p('f%dx' % i), p('f%dy' % i)] if held else None for i in range(4)]
    return [[v(c) or 0.0 for c in SHAPES]]

import numpy as np
_AT = {}

def gather(c, names):
    # The named channels' first values in one numpy read (NaN where missing); where each one sits is worked out once
    # per channel count (the OSC channels arrive over time), not looked up by name every frame.
    key = (c.path, c.numChans, names[0], len(names))
    at = _AT.get(key)
    if at is None:
        pos = dict((ch.name, i) for i, ch in enumerate(c.chans()))
        at = _AT[key] = np.array([pos.get(n, -1) for n in names])
    vals = c.numpyArray()[:, 0] if c.numChans else np.zeros(1)
    return np.where(at >= 0, vals[np.clip(at, 0, None)], np.nan)

POINTS = {'points': ('pt', 32, 'npts'), 'body': ('b', 33, 'nbody')}

def first(ch, name):
    c = ch.chan(name)
    return c[0] if c is not None else 0.0

def cook_points(scriptOp, name):
    # points / body / hands (no easing: the One Euro filters smooth them): the samples at once, numpy, as rows() did.
    ch, smooth = scriptOp.inputs[0], scriptOp.inputs[1] if len(scriptOp.inputs) > 1 else None
    def coords(names):  # filtered, or as sent where the filter hasn't the channel yet
        raw = gather(ch, names)
        return raw if smooth is None else np.where(np.isnan(f := gather(smooth, names)), raw, f)
    cols = []
    if name == 'hands':
        x, y, live = [], [], []
        for side in 'lr':
            on = first(ch, 'h%son' % side) > 0.5
            x.append(coords(['h%s%dx' % (side, i) for i in range(21)]))
            y.append(coords(['h%s%dy' % (side, i) for i in range(21)]))
            live.append(np.full(21, on))
        x, y, live = np.concatenate(x), np.concatenate(y), np.concatenate(live)
    else:
        prefix, count, n_name = POINTS[name]
        n = int(first(ch, n_name))
        x = coords(['%s%dx' % (prefix, i) for i in range(count)])
        y = coords(['%s%dy' % (prefix, i) for i in range(count)])
        live = np.arange(count) < n
        if name == 'body':
            cols = [gather(ch, ['b%dv' % i for i in range(count)])]
    live = live & ~np.isnan(x) & ~np.isnan(y)
    for c in cols:
        live &= ~np.isnan(c)
    out = [np.where(live, c, -1.0) for c in [x, y] + cols]
    scriptOp.clear()
    scriptOp.numSamples = len(x)
    for c, vals in zip(('x', 'y', 'v'), out):
        scriptOp.appendChan(c).vals = vals.tolist()

def onCook(scriptOp):
    name = scriptOp.name
    if name in ('points', 'body', 'hands'):
        cook_points(scriptOp, name)
        return
    now = rows(scriptOp.inputs[0], name, scriptOp.inputs[1] if len(scriptOp.inputs) > 1 else None)
    prev = scriptOp.fetch('prev', None) or []
    k = EASE.get(name, 1.0)
    out = []
    for i, r in enumerate(now):
        if r is None or any(x is None for x in r):
            out.append(None)
            continue
        p = prev[i] if i < len(prev) else None
        if p is None:
            out.append(r)  # just appeared: no easing in from nowhere
        elif name == 'shapes':
            out.append([b if SHAPES[j] in SNAP else a + FADE.get(SHAPES[j], k) * (b - a) for j, (a, b) in enumerate(zip(p, r))])
        else:
            out.append([a + k * (b - a) for a, b in zip(p, r)])
    fading = op('shapes')['fheld'] if name == 'frame' else None
    if fading is not None and float(fading) > 0.01 and prev and all(r is None for r in out):
        out = prev  # let go: the corners stay while FRAME held fades out
    scriptOp.store('prev', out)
    scriptOp.clear()
    scriptOp.numSamples = len(now)
    names = SHAPES if name == 'shapes' else ('x', 'y', 'v') if name == 'body' else ('x', 'y')
    chans = [scriptOp.appendChan(c) for c in names]
    for i, r in enumerate(out):
        for j, c in enumerate(chans):
            c[i] = r[j] if r else (-1.0 if name != 'shapes' else 0.0)
    return
'''
# One Euro (TouchDesigner's Filter CHOP): smooth while still, little lag when moving fast. On the coordinates as they
# arrive, per group; a group that reappears starts its filter afresh (no swoosh from where it was last seen).
# ponytail: cutoff / beta picked for 0-1 coordinates at 60 Hz, not tuned on real footage yet: tune with preview.cjs.
ONE_EURO = {'cutoff': 1.0, 'speedcoeff': 5.0, 'slopecutoff': 1.0}
GROUPS = {
    'points': ' '.join(f'pt{i}x pt{i}y' for i in range(NPTS)),
    'body': ' '.join(f'b{i}x b{i}y' for i in range(33)),
    'handl': ' '.join(f'hl{i}x hl{i}y' for i in range(21)),
    'handr': ' '.join(f'hr{i}x hr{i}y' for i in range(21)),
    'frame': ' '.join(f'f{i}x f{i}y' for i in range(4)),
}
smooth = {}
for y, (group, names) in enumerate(GROUPS.items()):
    sel = place(box.create(selectCHOP, 'raw_' + group), 1.4, 1 + y * 0.6)
    sel.inputConnectors[0].connect(ch)
    setp(sel, 'channames', names)
    f = place(box.create(filterCHOP, 'smooth_' + group), 1.7, 1 + y * 0.6)
    f.inputConnectors[0].connect(sel)
    setp(f, 'type', 'oneeuro')
    for name, value in ONE_EURO.items():
        setp(f, name, value)
    smooth[group] = f
hands_smooth = place(box.create(mergeCHOP, 'smooth_hands'), 1.9, 2.8)
hands_smooth.inputConnectors[0].connect(smooth['handl'])
hands_smooth.inputConnectors[1].connect(smooth['handr'])
appear = place(box.create(executeDAT, 'smooth_reset'), 1.7, 4.2)  # (a CHOP Execute's callbacks never fire in 2025.33230)
appear.text = '''
# a group back in view: its filter starts from where it is now (compared with the frame before)
FILTERS = {'npts': 'smooth_points', 'nbody': 'smooth_body', 'hlon': 'smooth_handl', 'hron': 'smooth_handr', 'fheld': 'smooth_frame'}
def onFrameStart(frame):
    ch, was = op('ch'), me.fetch('was', {})
    now = {}
    for name, f in FILTERS.items():
        c = ch[name]
        now[name] = float(c) > 0 if c is not None else False
        if now[name] and not was.get(name, False):
            op(f).par.resetpulse.pulse()
    me.store('was', now)
    return
'''
setp(appear, 'framestart', True)
track = {}
for y, name in enumerate(('points', 'body', 'hands', 'frame', 'shapes')):
    t = place(box.create(scriptCHOP, name), 2, 1 + y * 0.6)
    t.inputConnectors[0].connect(ch)
    filtered = hands_smooth if name == 'hands' else smooth.get(name)
    if filtered is not None:
        t.inputConnectors[1].connect(filtered)
    setp(t, 'callbacks', track_callbacks.name)
    track[name] = t


def shape(name):
    return f"(op('shapes')['{name}'] or 0)"


# The presets (touchdesigner/presets/<id>/: preset.json + frag.glsl), in FoxBox's order: /foxbox/td_preset's index.
PRESETS = json.loads(r'''__PRESETS__''')

# Prepended to each preset's frag.glsl (the contract: touchdesigner/presets/README.md).
HEADER = f'''
out vec4 fragColor;
uniform vec4 uAudio;  // kick, snare, dropenergy, seconds
uniform vec4 uGrid;   // beat, beatphase, kickcount, snarecount
uniform vec4 uCam;    // someone found, -, -, -
uniform vec4 uMacro;  // the preset's macros, 0..1
uniform vec4 uReact;  // x: the REACTS TO channel
uniform vec4 uPal0;
uniform vec4 uPal1;
uniform vec4 uPal2;
uniform vec4 uPal3;
uniform vec2 uPts[{NPTS}];  // the face's landmarks, 0..1 in the camera frame, y down (x < 0: off)
uniform vec3 uBody[33];  // BlazePose: x, y (camera frame, y down), z visibility (x < 0: off)
uniform vec2 uHands[42]; // left hand 0-20, right 21-41 (MediaPipe's order; x < 0: off)
uniform vec2 uFrame[4];  // the FRAME's corners while held (x < 0: none)
uniform vec4 uHand;      // left on, right on, left gesture, right gesture (1 fist 2 open 3 point 4 up 5 down 6 victory 7 love)
uniform vec4 uShapeL;    // pinch, open, fingers (0-5), -
uniform vec4 uShapeR;
uniform vec4 uShape;     // hands apart, FRAME size (held), triangle, FRAME held
float hash(vec2 p) {{ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }}
float noise(vec2 p) {{
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}}
float fbm(vec2 p) {{ float a = 0.5, s = 0.0; for (int i = 0; i < 5; i++) {{ s += a * noise(p); p *= 2.03; a *= 0.5; }} return s; }}
// The camera fills the frame (cover fit); before its first frame: black. Its alpha is the person matte.
bool hasCam() {{ return uTD2DInfos[0].res.z > 2.0; }}
vec2 camScale() {{
    vec2 res = uTDOutputInfo.res.zw, cam = uTD2DInfos[0].res.zw;
    float sa = res.x / res.y, ca = cam.x / max(cam.y, 1.0);
    return sa > ca ? vec2(1.0, ca / sa) : vec2(sa / ca, 1.0);
}}
vec2 toCam(vec2 uv) {{ return (uv - 0.5) * camScale() + 0.5; }}
vec3 cam(vec2 uv) {{ return hasCam() ? texture(sTD2DInputs[0], toCam(uv)).rgb : vec3(0.0); }}
float person(vec2 uv) {{ return hasCam() ? texture(sTD2DInputs[0], toCam(uv)).a : 0.0; }}
// a landmark (camera frame, y down) on screen (uv, y up)
vec2 ptToUV(vec2 p) {{ return (vec2(p.x, 1.0 - p.y) - 0.5) / camScale() + 0.5; }}
float segment(vec2 p, vec2 a, vec2 b) {{
    vec2 pa = p - a, ba = b - a;
    return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}}
// Distances below are in screen heights (x scaled by the aspect: circles stay round); 1e3 when there's nothing.
vec2 scr(vec2 uv) {{ return uv * vec2(uTDOutputInfo.res.z / uTDOutputInfo.res.w, 1.0); }}
bool jointOn(int i) {{ return uBody[i].x >= 0.0 && uBody[i].z >= 0.5; }}
vec2 joint(int i) {{ return ptToUV(uBody[i].xy); }}
float bone(vec2 uv, int a, int b) {{ return jointOn(a) && jointOn(b) ? segment(scr(uv), scr(joint(a)), scr(joint(b))) : 1e3; }}
// the arms and the torso: shoulders 11-12, elbows 13-14, wrists 15-16, hips 23-24
float bones(vec2 uv) {{
    float d = min(bone(uv, 11, 12), min(bone(uv, 11, 13), bone(uv, 13, 15)));
    d = min(d, min(bone(uv, 12, 14), bone(uv, 14, 16)));
    return min(d, min(bone(uv, 11, 23), min(bone(uv, 12, 24), bone(uv, 23, 24))));
}}
bool handOn(int side) {{ return (side == 0 ? uHand.x : uHand.y) > 0.5 && uHands[side * 21].x >= 0.0; }}
vec2 handPt(int side, int i) {{ return ptToUV(uHands[side * 21 + i]); }}
const int HAND_BONES[42] = int[42](0, 1, 1, 2, 2, 3, 3, 4, 0, 5, 5, 6, 6, 7, 7, 8, 5, 9, 9, 10, 10, 11, 11, 12, 9, 13, 13, 14,
                                   14, 15, 15, 16, 13, 17, 0, 17, 17, 18, 18, 19, 19, 20);
float fingers(vec2 uv) {{
    float d = 1e3;
    for (int s = 0; s < 2; s++) {{
        if (!handOn(s)) continue;
        for (int k = 0; k < 21; k++) d = min(d, segment(scr(uv), scr(handPt(s, HAND_BONES[2 * k])), scr(handPt(s, HAND_BONES[2 * k + 1]))));
    }}
    return d;
}}
// (distance to the nearest point of either hand, its side 0 / 1; -1 with no hands)
vec2 nearestHand(vec2 uv) {{
    vec2 best = vec2(1e3, -1.0);
    for (int s = 0; s < 2; s++) {{
        if (!handOn(s)) continue;
        for (int i = 0; i < 21; i++) {{
            float d = length(scr(uv) - scr(handPt(s, i)));
            if (d < best.x) best = vec2(d, float(s));
        }}
    }}
    return best;
}}
bool frameHeld() {{ return uShape.w > 0.5 && uFrame[0].x >= 0.0; }}
vec2 frameCorner(int i) {{ return ptToUV(uFrame[i]); }}
// inside the FRAME's quad (its corners in order round it)
bool inFrame(vec2 uv) {{
    if (!frameHeld()) return false;
    float sgn = 0.0;
    for (int i = 0; i < 4; i++) {{
        vec2 a = frameCorner(i), b = frameCorner((i + 1) % 4);
        float c = (b.x - a.x) * (uv.y - a.y) - (b.y - a.y) * (uv.x - a.x);
        if (sgn == 0.0) sgn = sign(c);
        else if (sign(c) != sgn) return false;
    }}
    return true;
}}
// a 3x5 digit (15 bits, the top row first, left column highest) in a glyph box, c in [0,1]^2
float digit(int d, vec2 c) {{
    int bits[10] = int[10](31599, 9362, 29671, 29391, 23497, 31183, 31215, 29257, 31727, 31695);
    ivec2 g = ivec2(floor(c * vec2(3.0, 5.0)));
    if (g.x < 0 || g.x > 2 || g.y < 0 || g.y > 4) return 0.0;
    return float((bits[d] >> (g.y * 3 + (2 - g.x))) & 1);
}}
'''
PREV = '''
// "feedback": this preset's own last output (black at first, and while another preset is showing)
vec3 prev(vec2 uv) { return texture(sTD2DInputs[1], uv).rgb; }
'''


def uniforms(glsl, vecs, arrays):
    """TouchDesigner 2025's GLSL TOP: uniforms in its Vectors and Arrays sequences (a new one has no blocks)."""
    try:
        glsl.seq.vec.numBlocks = len(vecs)
        if arrays:  # a new GLSL TOP has no array block to set to 0
            glsl.seq.array.numBlocks = len(arrays)
    except Exception:
        MISSING.append(f'{glsl.path}.seq')
    for i, (name, values) in enumerate(vecs):
        setp(glsl, f'vec{i}name', name)
        for comp, value in zip('xyzw', values):
            if isinstance(value, str):
                setp(glsl, f'vec{i}value{comp}', value, expr=True)
            else:
                setp(glsl, f'vec{i}value{comp}', value)
    for i, (name, kind, chop) in enumerate(arrays):
        setp(glsl, f'array{i}name', name)
        setp(glsl, f'array{i}type', kind)
        setp(glsl, f'array{i}chop', chop)
        setp(glsl, f'array{i}arraytype', 'uniformarray')


# v3's shared inputs (presets/README.md): each preset's Base COMP selects these as its in_* operators.
#   scr_points / scr_body / scr_hands / scr_frame   the tracking in screen space, one sample a point: u v (the picture's
#       uv after the camera's cover fit, y up: where it is in out1), tx ty tz (the same in world units for ortho(): x
#       across +-W/H/2, y +-0.5), on (0/1: tracked; the body's visibility >= 0.5; a hand on; the FRAME held)
#   cam_fit   the camera cover-fitted to W x H (the person matte in its alpha); matte  the matte as grey
SCREEN = f'''
import numpy as np
W, H = {W}, {H}

def onCook(scriptOp):
    src = scriptOp.inputs[0]
    cam = op('camera')
    sa, ca = W / H, (cam.width / max(cam.height, 1)) if cam.width > 2 else W / H
    sx, sy = (1.0, ca / sa) if sa > ca else (sa / ca, 1.0)  # as the shaders' camScale()
    names = [c.name for c in src.chans()]
    arr = src.numpyArray()
    x, y = arr[names.index('x')], arr[names.index('y')]
    on = x >= 0
    if 'v' in names:
        on &= arr[names.index('v')] >= 0.5
    u = np.where(on, (x - 0.5) / sx + 0.5, -1.0)
    v = np.where(on, (0.5 - y) / sy + 0.5, -1.0)
    scriptOp.clear()
    scriptOp.numSamples = src.numSamples
    for name, val in (('u', u), ('v', v), ('tx', np.where(on, (u - 0.5) * W / H, 0.0)), ('ty', np.where(on, v - 0.5, 0.0)),
                      ('tz', np.zeros(len(x))), ('on', on.astype(float))):
        scriptOp.appendChan(name).vals = val.tolist()
    return
'''
screen_callbacks = place(box.create(textDAT, 'screen_callbacks'), 3, 1)
screen_callbacks.text = SCREEN
scr = {}
for y, name in enumerate(('points', 'body', 'hands', 'frame')):
    t = place(box.create(scriptCHOP, 'scr_' + name), 3, 1.6 + y * 0.6)
    t.inputConnectors[0].connect(track[name])
    setp(t, 'callbacks', screen_callbacks.name)
    scr[name] = t
cam_fit = place(box.create(fitTOP, 'cam_fit'), 4, 0)
cam_fit.inputConnectors[0].connect(camera_up)
setp(cam_fit, 'outputresolution', 'custom')
setp(cam_fit, 'resolutionw', W)
setp(cam_fit, 'resolutionh', H)
setp(cam_fit, 'fit', 'fitoutside')  # cover, as cam()
matte_frag = place(box.create(textDAT, 'matte_frag'), 5, -1)
matte_frag.text = 'out vec4 fragColor;\nvoid main() { float a = texture(sTD2DInputs[0], vUV.st).a; fragColor = TDOutputSwizzle(vec4(a, a, a, 1.0)); }\n'
matte = place(box.create(glslTOP, 'matte'), 5, 0)
matte.inputConnectors[0].connect(cam_fit)
setp(matte, 'pixeldat', matte_frag.name)


# Helpers a build.py can use (besides setp and place, W and H, HEADER and the TouchDesigner globals). Names not
# reused below: the preset loop rebinds `glsl` (hence shader()).
def ortho(parent, name='cam'):
    """An orthographic camera over the picture: the points' tx / ty land where their u / v are."""
    c = parent.create(cameraCOMP, name)
    setp(c, 'projection', 'ortho')
    setp(c, 'orthowidth', W / H)
    setp(c, 'tz', 5)
    return c


def render(parent, name, geometry, camera, lights=''):
    """A Render TOP at W x H on a transparent background: `geometry` a pattern of Geometry COMP names."""
    r = parent.create(renderTOP, name)
    setp(r, 'outputresolution', 'custom')
    setp(r, 'resolutionw', W)
    setp(r, 'resolutionh', H)
    setp(r, 'camera', camera.name)
    setp(r, 'geometry', geometry)
    setp(r, 'lights', lights)
    return r


def shader(parent, name, code, inputs=(), header=False):
    """A GLSL TOP node at W x H (its pixel code in name_frag; HEADER's helpers first with header=True)."""
    d = parent.create(textDAT, name + '_frag')
    d.text = (HEADER if header else 'out vec4 fragColor;\n') + code
    g = parent.create(glslTOP, name)
    for i, src in enumerate(inputs):
        g.inputConnectors[i].connect(src)
    setp(g, 'pixeldat', d.name)
    setp(g, 'outputresolution', 'custom')
    setp(g, 'resolutionw', W)
    setp(g, 'resolutionh', H)
    return g


# The tracking's bones (indices into in_body / in_hands per hand / in_face), for skeleton().
BONES = {
    'body': [(11, 12), (11, 13), (13, 15), (12, 14), (14, 16), (11, 23), (12, 24), (23, 24)],
    'hands': [(0, 1), (1, 2), (2, 3), (3, 4), (0, 5), (5, 6), (6, 7), (7, 8), (5, 9), (9, 10), (10, 11), (11, 12), (9, 13),
              (13, 14), (14, 15), (15, 16), (13, 17), (0, 17), (17, 18), (18, 19), (19, 20)],
    'face': [(i, (i + 1) % 12) for i in range(12)] + [(12, 13), (14, 15), (16, 18), (18, 17), (19, 21), (21, 20),
                                                      (24, 26), (26, 25), (25, 27), (27, 24)],
}


def bare_geo(parent, name, material=None):
    """A Geometry COMP with nothing inside (a new one comes with a torus), drawn with `material` (a sibling MAT)."""
    g = parent.create(geometryCOMP, name)
    for c in list(g.children):
        c.destroy()
    if material is not None:
        setp(g, 'material', material.name)
    return g


def skeleton(parent, name, material, parts=('body', 'hands')):
    """A Geometry COMP of the tracking's bones as line segments in ortho() world units, drawn with `material` (a Line
    MAT). Within the cook budget: a numpy Script CHOP lays each bone's two ends out as samples (an untracked bone's far
    off-screen) and a CHOP to POP joins them in pairs on the GPU, no geometry rebuilt in Python each frame."""
    segs = [(part, base + a, base + b) for part in parts for base in ((0, 21) if part == 'hands' else (0,))
            for a, b in BONES[part]]
    cb = parent.create(textDAT, name + '_segs_callbacks')
    cb.text = f"""
import numpy as np
SEGS = {segs!r}
PARTS = sorted(set(p for p, a, b in SEGS))
IDX = {{p: (np.array([a for q, a, b in SEGS if q == p]), np.array([b for q, a, b in SEGS if q == p])) for p in PARTS}}

def onCook(scriptOp):
    xs, ys = [], []
    for part in PARTS:
        c = op('in_' + part)
        names = [ch.name for ch in c.chans()]
        arr = c.numpyArray()
        tx, ty, on = arr[names.index('tx')], arr[names.index('ty')], arr[names.index('on')]
        a, b = IDX[part]
        live = (on[a] > 0.5) & (on[b] > 0.5)
        x = np.empty(2 * len(a)); y = np.empty(2 * len(a))
        x[0::2], x[1::2] = np.where(live, tx[a], 1000.0), np.where(live, tx[b], 1000.0)
        y[0::2], y[1::2] = np.where(live, ty[a], 1000.0), np.where(live, ty[b], 1000.0)
        xs.append(x); ys.append(y)
    x, y = np.concatenate(xs), np.concatenate(ys)
    scriptOp.clear()
    scriptOp.numSamples = len(x)
    for n, v in (('tx', x), ('ty', y), ('tz', np.zeros(len(x)))):
        scriptOp.appendChan(n).vals = v.tolist()
    return
"""
    pts = parent.create(scriptCHOP, name + '_segs')
    setp(pts, 'callbacks', cb.name)
    g = bare_geo(parent, name, material)
    p = g.create(choptoPOP, 'lines')
    for k, v in dict(chop='../' + pts.name, surftype='lines', attrscope='P').items():
        setp(p, k, v)
    setp(p, 'chanscope', 'tx ty tz')
    p.render = p.display = True
    return g


SHAPES_SOP = {
    'circle': """
def onCook(scriptOp):
    import math
    scriptOp.clear()
    p = scriptOp.appendPoly(24, closed=True, addPoints=True)
    for i in range(24):
        p[i].point.x, p[i].point.y = math.cos(i / 24 * 2 * math.pi), math.sin(i / 24 * 2 * math.pi)
    return
""",
    'bracket': """
def onCook(scriptOp):
    scriptOp.clear()
    for sx in (-1, 1):
        for sy in (-1, 1):
            for end in ((sx * 0.45, sy), (sx, sy * 0.45)):
                p = scriptOp.appendPoly(2, closed=False, addPoints=True)
                p[0].point.x, p[0].point.y = sx, sy
                p[1].point.x, p[1].point.y = end
    return
""",
}


def instances(parent, name, picks, size, material, shape='circle'):
    """A Geometry COMP instancing a unit `shape` ('circle': a filled disc, 'bracket': four corners) on chosen tracked
    points, `picks` [('body', 15), ('hands', 4), ('hands', 25), ...], each `size` (a Python expression, in ortho() world
    units; `k` the pick's index) while tracked, 0 while not. Its instances are the `<name>_pts` Script CHOP (tx ty s),
    numpy (the cook budget)."""
    cb = parent.create(textDAT, name + '_pts_callbacks')
    cb.text = f"""
import numpy as np
PICKS = {list(picks)!r}
PARTS = sorted(set(p for p, i in PICKS))

def onCook(scriptOp):
    tx, ty, sc = np.zeros(len(PICKS)), np.zeros(len(PICKS)), np.zeros(len(PICKS))
    for part in PARTS:
        c = op('in_' + part)
        names = [ch.name for ch in c.chans()]
        arr = c.numpyArray()
        ks = [k for k, (p, i) in enumerate(PICKS) if p == part]
        idx = np.array([PICKS[k][1] for k in ks])
        tx[ks], ty[ks] = arr[names.index('tx')][idx], arr[names.index('ty')][idx]
        on = arr[names.index('on')][idx] > 0.5
        sc[ks] = np.where(on, [({size}) for k in ks], 0.0)
    scriptOp.clear()
    scriptOp.numSamples = len(PICKS)
    for n, v in (('tx', tx), ('ty', ty), ('s', sc)):
        scriptOp.appendChan(n).vals = v.tolist()
    return
"""
    pts = parent.create(scriptCHOP, name + '_pts')
    setp(pts, 'callbacks', cb.name)
    sop_cb = parent.create(textDAT, name + '_shape_callbacks')
    sop_cb.text = SHAPES_SOP[shape]
    g = bare_geo(parent, name, material)
    for k, v in dict(instancing=True, instancecountmode='oplength', instanceop=pts.name, instancetx='tx', instancety='ty',
                     instancesx='s', instancesy='s', instancesz='s').items():
        setp(g, k, v)
    s = g.create(scriptSOP, shape)
    setp(s, 'callbacks', '../' + sop_cb.name)
    s.render = s.display = True
    return g



SQUARE_SOP = """
def onCook(scriptOp):
    scriptOp.clear()
    p = scriptOp.appendPoly(4, closed=True, addPoints=True)
    for i, (x, y) in enumerate(((-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5))):
        p[i].point.x, p[i].point.y = x, y
    return
"""


def windows(parent, name, wins, bar=0.03):
    """Desktop-style windows (MOSAIC, FINGER WINDOWS) from `wins`, a CHOP with one sample a window: tx ty (its centre),
    sx sy (its inside), in ortho() world units (sx 0: not shown). Two Render TOPs: <name>_mask (white where a window's
    inside is: composite the camera through it) and <name>_chrome (each window's title bar in Ink, close box in Accent,
    outline in Ink, on transparent). `bar`: the title bar's height."""
    cb = parent.create(textDAT, name + '_parts_callbacks')
    cb.text = f"""
BAR = {bar}

def onCook(scriptOp):
    w = scriptOp.inputs[0]
    n = w.numSamples
    scriptOp.clear()
    scriptOp.numSamples = n
    names = ('ftx', 'fty', 'fsx', 'fsy', 'btx', 'bty', 'bsx', 'bsy', 'ctx', 'cty', 'cs', 'otx', 'oty', 'osx', 'osy')
    c = dict((k, scriptOp.appendChan(k)) for k in names)
    for i in range(n):
        tx, ty, sx, sy = w['tx'][i], w['ty'][i], w['sx'][i], w['sy'][i]
        on = 1.0 if sx > 1e-4 else 0.0
        c['ftx'][i], c['fty'][i], c['fsx'][i], c['fsy'][i] = tx, ty, sx, sy
        c['btx'][i], c['bty'][i], c['bsx'][i], c['bsy'][i] = tx, ty + sy / 2 + BAR / 2, sx, BAR * on
        c['ctx'][i], c['cty'][i], c['cs'][i] = tx + sx / 2 - BAR * 0.6, ty + sy / 2 + BAR / 2, BAR * 0.6 * on
        c['otx'][i], c['oty'][i], c['osx'][i], c['osy'][i] = tx, ty + BAR / 2 * on, sx, (sy + BAR) * on
    return
"""
    parts = parent.create(scriptCHOP, name + '_parts')
    parts.inputConnectors[0].connect(wins)
    setp(parts, 'callbacks', cb.name)
    square = parent.create(textDAT, name + '_square_callbacks')
    square.text = SQUARE_SOP

    def mat(kind, mname, color, **extra):
        m = parent.create(kind, mname)
        for k, v in extra.items():
            setp(m, k, v)
        for ch_, v in zip('rgb', color):
            setp(m, (('linenearcolor' if kind is lineMAT else 'color') + ch_), v, expr=True)
        return m

    def inst(gname, material, prefix, shape):
        g = bare_geo(parent, gname, material)
        sx, sy = (prefix + 's', prefix + 's') if prefix == 'c' else (prefix + 'sx', prefix + 'sy')
        for k, v in dict(instancing=True, instancecountmode='oplength', instanceop=parts.name, instancetx=prefix + 'tx',
                         instancety=prefix + 'ty', instancesx=sx, instancesy=sy).items():
            setp(g, k, v)
        if shape == 'rect':
            r = g.create(rectangleSOP, 'rect')
            setp(r, 'sizex', 1)
            setp(r, 'sizey', 1)
        else:
            r = g.create(scriptSOP, 'square')
            setp(r, 'callbacks', '../' + square.name)
        r.render = r.display = True
        return g

    ink = [f'parent().par.Ink{c}' for c in 'rgb']
    accent = [f'parent().par.Accent{c}' for c in 'rgb']
    white = mat(constantMAT, name + '_white', ['1', '1', '1'])
    inst(name + '_fill', white, 'f', 'rect')
    inst(name + '_bar', mat(constantMAT, name + '_inkmat', ink), 'b', 'rect')
    inst(name + '_close', mat(constantMAT, name + '_accentmat', accent), 'c', 'rect')
    inst(name + '_outline', mat(lineMAT, name + '_linemat', ink, widthnear=1.5, widthfar=1.5, drawpoints=False), 'o', 'square')
    cam = ortho(parent, name + '_cam')
    mask = render(parent, name + '_mask', name + '_fill', cam)
    chrome = render(parent, name + '_chrome', ' '.join(name + p for p in ('_bar', '_close', '_outline')), cam)
    return mask, chrome


# Desk: the camera through the windows' mask, the room outside them (`room`: 0 the palette's background, 1 the camera),
# and the windows' chrome over it all. A GLSL node (inputs: camera, mask, chrome).
WINDOW_DESK = """
uniform vec4 uBg;
uniform vec4 uKnobs;  // room (0 bg .. 1 the camera dimmed), colour (0 mono .. 1 colour), -, -
void main() {
    vec2 uv = vUV.st;
    vec3 cam = texture(sTD2DInputs[0], uv).rgb;
    float mono = dot(cam, vec3(0.299, 0.587, 0.114));
    cam = mix(vec3(mono), cam, uKnobs.y);
    float inside = texture(sTD2DInputs[1], uv).a;
    vec4 chrome = texture(sTD2DInputs[2], uv);
    vec3 room = mix(uBg.rgb, cam * 0.35, uKnobs.x);
    vec3 col = mix(room, cam, inside);
    col = mix(col, chrome.rgb, chrome.a);
    fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
"""


def glow(parent, name, src, intensity, res='quarter'):
    """A glow on `src` within the cook budget: what's bright (over 0.65) at `res` (quarter size by default; it's soft
    anyway), blurred, added back over the full-size picture with its alpha (so it lays over others). A Level and a Blur,
    not a Bloom TOP (2.5-3 ms a frame at quarter size in the runs: S2). `intensity`: a value or an expression ('=...').
    Returns the composite."""
    bright = parent.create(levelTOP, name + '_bright')
    bright.inputConnectors[0].connect(src)
    for k, v in dict(outputresolution=res, inlow=0.65).items():
        setp(bright, k, v)
    expr = isinstance(intensity, str) and intensity.startswith('=')
    setp(bright, 'brightness1', intensity[1:] if expr else intensity, expr=expr)
    b = parent.create(blurTOP, name + '_blur')
    b.inputConnectors[0].connect(bright)
    for k, v in dict(type='gaussian', size=12).items():
        setp(b, k, v)
    c = parent.create(compositeTOP, name)
    c.inputConnectors[0].connect(src)
    c.inputConnectors[1].connect(b)
    setp(c, 'operand', 'add')
    return c


BUILD_ERRORS = []
NETWORKS = []  # (index, Base COMP): the v3 presets, for activate()


# The design's play controls (app/design/visuals-td §B): six knobs on every preset, FoxBox sending their final values
# (reacts-to modulation applied) as /foxbox/knob_<name>; until it does, the design's defaults.
KNOBS = (('Intensity', 0.6), ('Colour', 0.5), ('Chaos', 0.25), ('Trails', 0.15), ('Lines', 0.45), ('Size', 0.5))
# Its palettes: three stops (bg, ink, accent), picked by name (/foxbox/palette, text); EMBER until one arrives.
palettes = place(box.create(textDAT, 'palettes'), 4, -1)
palettes.text = '''
PALETTES = {'ember': ('050506', 'f2efe6', 'ff4b2b'), 'ice': ('03060a', 'e8f4ff', '29a8ff'), 'toxic': ('040602', 'f1ffe0', 'b6ff2e'),
            'bone': ('0d0b08', 'efe6d2', 'c9b48a'), 'void': ('000000', 'ffffff', '8a5cff')}

def stop(i, c):
    """Stop i (0 bg, 1 ink, 2 accent) of the palette showing, channel c (0 r, 1 g, 2 b), 0-1."""
    t = op('text')
    name = t['palette', 1].val.strip().lower() if t.row('palette') else 'ember'
    h = PALETTES.get(name, PALETTES['ember'])[i]
    return int(h[2 * c:2 * c + 2], 16) / 255
'''


def network(x, preset):
    """A v3 preset: a Base COMP with the standard inputs and the play controls as parameters (Intensity ... Size, the
    palette's Bg / Ink / Accent), built by its build.py (which ends by connecting its picture to out1). A build
    that fails shows the camera, and its error goes to status."""
    comp = place(box.create(baseCOMP, 'p_' + preset['id']), 4 + x, 2)
    page = comp.appendCustomPage('FoxBox')
    for name, default in KNOBS:
        page.appendFloat(name)
        c = f"op('{ch.path}')['knob_{name.lower()}']"
        setp(comp, name, f"float({c}) if {c} is not None else {default}", expr=True)
    for i, name in enumerate(('Bg', 'Ink', 'Accent')):
        page.appendRGB(name)
        for j, c in enumerate('rgb'):
            setp(comp, f'{name}{c}', f"mod('{palettes.path}').stop({i}, {j})", expr=True)
    for y, (kind, name, path) in enumerate((
        (selectTOP, 'in_cam', cam_fit.path), (selectTOP, 'in_matte', matte.path),
        (selectCHOP, 'in_ch', ch.path), (selectCHOP, 'in_shapes', track['shapes'].path),
        (selectCHOP, 'in_face', scr['points'].path), (selectCHOP, 'in_body', scr['body'].path),
        (selectCHOP, 'in_hands', scr['hands'].path), (selectCHOP, 'in_frame', scr['frame'].path),
    )):
        n = place(comp.create(kind, name), 0, y)
        setp(n, 'top' if kind is selectTOP else 'chops', path)
    for y, name in enumerate(('face', 'body', 'hands', 'frame')):
        pts = place(comp.create(choptoSOP, f'in_{name}_pts'), 1, 4 + y)
        setp(pts, 'chop', f'in_{name}')
    out1 = place(comp.create(outTOP, 'out1'), 8, 0)
    env = dict(globals())
    env.update(comp=comp, preset=preset)
    try:
        exec(compile(preset['build'], f"presets/{preset['id']}/build.py", 'exec'), env)
    except Exception:
        BUILD_ERRORS.append(f"{preset['id']}: {traceback.format_exc(limit=3)}")
    # What reaches FoxBox is opaque: the camera carries the person matte in alpha, and a build's picture may too.
    src = out1.inputs[0] if out1.inputs else comp.op('in_cam')
    black = place(comp.create(constantTOP, 'opaque_black'), 7, 1)
    for k, v in dict(outputresolution='custom', resolutionw=W, resolutionh=H, colorr=0, colorg=0, colorb=0, alpha=1).items():
        setp(black, k, v)
    opaque = place(comp.create(overTOP, 'opaque'), 7, 0)
    opaque.inputConnectors[0].connect(src)
    opaque.inputConnectors[1].connect(black)
    out1.inputConnectors[0].connect(opaque)
    NETWORKS.append((x, comp))
    return comp


black = place(box.create(constantTOP, 'black'), 3, 4)  # what a feedback preset starts from
setp(black, 'outputresolution', 'custom')
setp(black, 'resolutionw', W)
setp(black, 'resolutionh', H)
setp(black, 'colorr', 0)
setp(black, 'colorg', 0)
setp(black, 'colorb', 0)

looks = []
for x, preset in enumerate(PRESETS):
    if preset.get('build'):
        looks.append(network(x, preset).outputConnectors[0])
        continue
    name = 'p_' + preset['id']
    frag = place(box.create(textDAT, name + '_frag'), 4 + x, 4)
    frag.text = HEADER + (PREV if preset.get('feedback') else '') + preset['frag']
    glsl = place(box.create(glslTOP, name), 4 + x, 2)
    glsl.inputConnectors[0].connect(camera_up)
    if preset.get('feedback'):
        fb = place(box.create(feedbackTOP, name + '_prev'), 4 + x, 3)
        fb.inputConnectors[0].connect(black)
        setp(fb, 'top', glsl.name)
        setp(fb, 'reset', f"int({channel('td_preset')}) != {x}", expr=True)  # held black while another is showing
        glsl.inputConnectors[1].connect(fb)
    setp(glsl, 'pixeldat', frag.name)
    setp(glsl, 'outputresolution', 'custom')
    setp(glsl, 'resolutionw', W)
    setp(glsl, 'resolutionh', H)
    setp(glsl, 'format', 'rgba8fixed')  # 8-bit RGBA: what FoxBox takes over Syphon
    pal = (preset.get('palette') or []) + [[0.0, 0.0, 0.0, 1.0]] * 4
    uniforms(glsl, [
        ('uAudio', (channel('kick'), channel('snare'), channel('dropenergy'), 'absTime.seconds')),
        ('uGrid', (channel('beat'), channel('beatphase'), channel('kickcount'), channel('snarecount'))),
        ('uCam', (channel('face'), '0', '0', '0')),
        ('uMacro', tuple(channel(f'tdmacro{i}') for i in range(4))),
        ('uReact', (channel('react'), '0', '0', '0')),
        ('uHand', (shape('hlon'), shape('hron'), shape('hlgest'), shape('hrgest'))),
        ('uShapeL', (shape('hlpinch'), shape('hlopen'), shape('hlfingers'), '0')),
        ('uShapeR', (shape('hrpinch'), shape('hropen'), shape('hrfingers'), '0')),
        ('uShape', (shape('apart'), shape('fsize'), shape('triangle'), shape('fheld'))),
    ] + [(f'uPal{i}', tuple(pal[i])) for i in range(4)], [
        ('uPts', 'vec2', track['points'].name),
        ('uBody', 'vec3', track['body'].name),
        ('uHands', 'vec2', track['hands'].name),
        ('uFrame', 'vec2', track['frame'].name),
    ])
    looks.append(glsl)

look = place(box.create(switchTOP, 'look'), 4 + len(PRESETS), 2)
for i, glsl in enumerate(looks):
    look.inputConnectors[i].connect(glsl)
setp(look, 'index', f"int({channel('td_preset')})", expr=True)
look_up = place(box.create(flipTOP, 'look_up'), 5 + len(PRESETS), 2)
# FIST's commands, for every preset: freeze (the picture held) and blackout
cmd_state = place(box.create(tableDAT, 'cmd_state'), 5 + len(PRESETS), 4)
cmd_state.clear()
cmd_state.appendRows([['freeze', '0'], ['blackout', '0']])
preset_ids = place(box.create(tableDAT, 'preset_ids'), 5 + len(PRESETS), 5)
preset_ids.clear()
preset_ids.appendRows([[p['id']] for p in PRESETS])
# (freeze locks `look` on the command: a Cache TOP holding it copied the picture every frame, the run's dearest op)
dark = place(box.create(switchTOP, 'dark'), 5.5 + len(PRESETS), 3)
dark.inputConnectors[0].connect(look)
dark.inputConnectors[1].connect(black)
setp(dark, 'index', "int(op('cmd_state')['blackout', 1].val)", expr=True)
look_up.inputConnectors[0].connect(dark)
setp(look_up, 'flipy', True)
syphon = place(box.create(syphonspoutoutTOP, 'syphon'), 6 + len(PRESETS), 2)
syphon.inputConnectors[0].connect(look_up)
setp(syphon, 'sendername', SENDER)
look.viewer = True

# Only the preset showing cooks (a v3 network can be heavy); one switched to starts clean (its Feedback TOPs reset), and
# when MASK FIRST switches (/foxbox/maskfirst) every preset forgets its past frames (an unmasked face in a trail).
# Checked each frame (a CHOP Execute's value-change event never came for td_preset in 2025.33230).
activate = place(box.create(executeDAT, 'activate'), 4 + len(PRESETS), 1)
activate.text = f'''
NETWORKS = {[(i, c.path) for i, c in NETWORKS]!r}
SHOWN = [-1]

def show(index):
    for i, path in NETWORKS:
        comp = op(path)
        on = i == index
        if on and not comp.allowCooking:
            for fb in comp.findChildren(type=feedbackTOP):
                fb.par.resetpulse.pulse()
        comp.allowCooking = on
    SHOWN[0] = index

MASKED = [None]

def forget():
    # Every preset's memory of past frames (feedback trails, Texture 3D TOP frame stacks) cleared at once.
    for o in parent().findChildren(type=feedbackTOP) + parent().findChildren(type=texture3dTOP):
        o.par.resetpulse.pulse()
    op('look').lock = False  # a frozen picture is a past frame too
    op('cmd_state')['freeze', 1] = '0'

def onFrameStart(frame):
    v = op('ch')['td_preset']
    index = int(float(v)) if v is not None else 0
    if index != SHOWN[0]:
        show(index)
    # MASK FIRST switched (on: the faces hidden from here): no trail may still carry an earlier unmasked frame.
    m = op('ch')['maskfirst']
    masked = float(m) if m is not None else 0.0
    if MASKED[0] is not None and masked != MASKED[0]:
        forget()
    MASKED[0] = masked
    return
'''
setp(activate, 'framestart', True)

# The cook budget (12 ms a frame at 1280 x 720), measured in preview.cjs's runs (FOXBOX_TD_PERF=1), for the preset
# showing, after its first 1.5 s (shader compiles and first cooks aren't the steady cost):
#   frame_ms  the frame's CPU wall time, start to end (host + preset + out: what the budget is about)
#   gpu_ms    the preset's operators' GPU cook times summed
#   cook_ms   its operators that cooked this frame, CPU + GPU summed, with the eight dearest (an op that pulls
#             another's cook counts it too)
#   host_ms   the host's input side (OSC, camera, matte, tracking and its filters) summed: not its output side, whose
#             first op pulls the preset (so would count it again)
#   period_ms the wall time from one frame's end to the next (1000 / fps: what the frame costs all told), skipped the
#             timeline frames TouchDesigner dropped a frame (realtime: it skips to keep time), cook_rate its target
#   everywhere the eight dearest ops of the preset AND the whole host (input side, output side: look, dark, syphon)
#   host_wall_ms the host's input side's wall time, cooked first at frame start; stage_ms each later stage's wall time,
#             cooked in order after it (preset, look, dark_flip, syphon); perf_ms this DAT's own cost a frame
# into STATUS_PATH + '.perf.json' every 30 measured frames (by count: a slow preset still gets written).
perf = place(box.create(executeDAT, 'perf'), 4 + len(PRESETS), 0) if os.environ.get('FOXBOX_TD_PERF') else None  # preview only
PERF_TEXT = f'''
import json, time
ACC = {{}}
WARMUP_S = 1.5  # left out after a preset first shows
HOST = ('in_foxbox', 'ch', 'camera', 'camera_up', 'smooth_hands', 'points', 'body', 'hands', 'frame', 'shapes', 'cam_fit', 'matte')
HOST_PREFIX = ('raw_', 'smooth_', 'scr_')

def ms(o, gpu_only=False):
    # cpu/gpuCookTime are the op's LAST cook: a static op (an atlas cooked once) counts only in the frame it cooks
    if getattr(o, 'cookAbsFrame', absTime.frame) != absTime.frame:
        return 0.0
    g = float(getattr(o, 'gpuCookTime', 0) or 0)
    return g if gpu_only else g + float(getattr(o, 'cpuCookTime', 0) or 0)

def is_host(o):
    return o.name in HOST or o.name.startswith(HOST_PREFIX)

def shown():
    v = op('ch')['td_preset']
    index = int(float(v)) if v is not None else 0
    ids = op('preset_ids')
    comp = op('p_' + ids[index, 0].val) if ids is not None and index < ids.numRows else None
    return comp if comp is not None and comp.isCOMP else None

def onFrameStart(frame):
    me.store('t0', time.perf_counter())
    # Syphon Out on / off (preview's /foxbox/perfsyphon 1: off), the A/B: does publishing wait on the GPU?
    v = op('ch')['perfsyphon']
    off = v is not None and float(v) > 0.5
    s = op('syphon')
    active = getattr(s.par, 'active', None)
    if active is not None:
        if bool(active.eval()) == off:
            active.val = not off
    elif s.bypass != off:
        s.bypass = off
    # The host's input side that cooked last frame, cooked here first and timed: its wall time once (summed per op, an
    # upstream op counts again inside each op that pulls it; the presets then find it cooked).
    t = time.perf_counter()
    for o in me.fetch('host_live', []):
        o.cook()
    me.store('host_wall', (time.perf_counter() - t) * 1000)
    # Then each stage after it, in order, each timed alone (what it pulls is already cooked): the preset, the switch to
    # it (FIST's freeze locks it), blackout and the flip, Syphon Out. The CPU wall of each (a stage that waits on the GPU
    # shows it here).
    comp = shown()
    walls = {{}}
    for name, ops in (('preset', [comp.op('out1') if comp else None]), ('look', [op('look')]),
                      ('dark_flip', [op('dark'), op('look_up')]), ('syphon', [op('syphon')])):
        t = time.perf_counter()
        for o in ops:
            if o is not None:
                o.cook()
        walls[name] = (time.perf_counter() - t) * 1000
    me.store('walls', walls)
    return

def onFrameEnd(frame):
    began = time.perf_counter()
    t0 = me.fetch('t0', None)
    comp = shown()
    if comp is None or t0 is None:
        return
    r = op('ch')['perfrun']  # preview.cjs's window: a new one starts the preset's sums afresh (a re-run after a render)
    run = float(r) if r is not None else 0.0
    a = ACC.get(comp.name)
    if a is None or a['run'] != run:
        a = ACC[comp.name] = {{'n': 0, 'frame': 0.0, 'gpu': 0.0, 'ms': 0.0, 'host': 0.0, 'ops': {{}}, 'first': time.perf_counter(), 'run': run,
                               'period': 0.0, 'periods': 0, 'skipped': 0, 'all': {{}}, 'host_wall': 0.0, 'perf': 0.0, 'stages': {{}}}}
    now, last = time.perf_counter(), me.fetch('last', None)
    me.store('last', (now, absTime.frame))
    if time.perf_counter() - a['first'] < WARMUP_S:
        return
    if last is not None:
        a['period'] += (now - last[0]) * 1000
        a['skipped'] += max(0, absTime.frame - last[1] - 1)
        a['periods'] += 1
    a['frame'] += (time.perf_counter() - t0) * 1000
    a['host_wall'] += me.fetch('host_wall', 0.0)
    for k, w in me.fetch('walls', {{}}).items():
        a['stages'][k] = a['stages'].get(k, 0.0) + w
    for o in comp.findChildren():
        t = ms(o)
        a['ms'] += t
        a['gpu'] += ms(o, True)
        a['ops'][o.name] = a['ops'].get(o.name, 0.0) + t
    live = []
    for o in me.parent().findChildren(depth=1):
        if o.name.startswith('p_'):
            continue
        t = ms(o)
        if is_host(o):
            a['host'] += t
            if getattr(o, 'cookAbsFrame', -1) == absTime.frame:
                live.append(o)
        a['all']['host/' + o.name] = a['all'].get('host/' + o.name, 0.0) + t
    me.store('host_live', live)
    for k, t in a['ops'].items():
        a['all'][k] = t
    a['n'] += 1
    if a['n'] % 30 == 0:
        out = {{}}
        for name, x in ACC.items():
            per = lambda t: round(t / max(1, x['n']), 2)
            out[name] = {{'frame_ms': per(x['frame']), 'gpu_ms': per(x['gpu']), 'cook_ms': per(x['ms']), 'host_ms': per(x['host']),
                         'frames': x['n'], 'dearest': sorted(((k, per(t)) for k, t in x['ops'].items()), key=lambda kv: -kv[1])[:8],
                         'period_ms': round(x['period'] / max(1, x['periods']), 2), 'skipped': round(x['skipped'] / max(1, x['periods']), 2),
                         'cook_rate': project.cookRate, 'everywhere': sorted(((k, per(t)) for k, t in x['all'].items()), key=lambda kv: -kv[1])[:8],
                         'host_wall_ms': per(x['host_wall']), 'perf_ms': per(x['perf']),
                         'stage_ms': dict((k, per(w)) for k, w in x['stages'].items())}}
        with open(r'{STATUS_PATH}.perf.json', 'w') as f:
            json.dump(out, f)
    a['perf'] += (time.perf_counter() - began) * 1000  # this DAT's own cost (outside frame_ms, inside period_ms)
    return
'''
if perf is not None:
    perf.text = PERF_TEXT
    setp(perf, 'framestart', True)
    setp(perf, 'frameend', True)
activate.module.show(-1)  # none until the first frame says which

def full_speed():
    """macOS throttles a hidden app that isn't the user's focus (App Nap, background QoS): TouchDesigner ran 6x slower a
    few minutes into a hidden session (the perf DAT's own Python 0.37 -> 2.4 ms a frame). An activity held for the
    session (user-initiated and latency-critical, idle sleep still allowed) keeps it at full speed: NSProcessInfo
    through the Objective-C runtime, nothing written to the user's defaults. Returns 'on' or why not."""
    try:
        import ctypes
        import ctypes.util
        objc = ctypes.cdll.LoadLibrary(ctypes.util.find_library('objc'))
        objc.objc_getClass.restype = objc.sel_registerName.restype = ctypes.c_void_p
        objc.objc_getClass.argtypes = objc.sel_registerName.argtypes = [ctypes.c_char_p]
        P = ctypes.c_void_p
        send = lambda *types: ctypes.CFUNCTYPE(P, P, P, *types)(('objc_msgSend', objc))  # noqa: E731
        info = send()(objc.objc_getClass(b'NSProcessInfo'), objc.sel_registerName(b'processInfo'))
        reason = send(ctypes.c_char_p)(objc.objc_getClass(b'NSString'), objc.sel_registerName(b'stringWithUTF8String:'),
                                       b'FoxBox visuals')
        # NSActivityUserInitiatedAllowingIdleSystemSleep | NSActivityLatencyCritical
        token = send(ctypes.c_uint64, P)(info, objc.sel_registerName(b'beginActivityWithOptions:reason:'),
                                        0x00EFFFFF | 0xFF00000000, reason)
        if not token:
            return 'no activity'
        send()(token, objc.sel_registerName(b'retain'))  # held for the session (TouchDesigner quits with FoxBox)
        return 'on'
    except Exception as e:
        return f'failed: {e}'


FULL_SPEED = full_speed()
look.cook(force=True)
errors = BUILD_ERRORS + [f'{o.path}: {o.errors()}' for o in box.findChildren() if o.errors()]
status = {'ok': True, 'version': app.version, 'build': app.build, 'product': str(app.product), 'syphon': SENDER,
          'missing': MISSING, 'errors': errors, 'built_at': time.time(), 'pid': os.getpid(), 'full_speed': FULL_SPEED}  # FoxBox quits only this pid
with open(STATUS_PATH, 'w') as f:
    json.dump(status, f)
# Never perform mode: its window comes on screen even from a hidden launch, and a user closing that stray window
# quits FoxBox's TouchDesigner. Hidden, the editor draws nothing either.

