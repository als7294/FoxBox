"""SLIT SCAN (v3, a TouchDesigner network): TouchDesigner's own slit-scan. The camera (half size) runs into a Texture 3D
TOP holding its last 64 frames, and a Time Machine TOP reads every pixel from the frame a map says (black: now, white:
the oldest it reaches). The map (a GLSL node): the distance from your hand's palm, cut into bands, so the rows at your
hand run live and the further ones lag (sweep the hand to scrub time); reaching your arms out reaches further back.
The knobs: LINES the number of bands, CHAOS the bands re-dealt on the beat, TRAILS how far back, COLOUR the lagging
rows in the accent, INTENSITY contrast, SIZE the live window round the hand. Drop: the bands turn vertical.
Recipe: TouchDesigner's Time Machine slit-scan (Texture 3D TOP + a grey map), as in DBraun's SlitScanSimplest.
"""

ACCENT = [f'=parent().par.Accent{c}' for c in 'rgb']


def node(kind, name, x, y, inputs=(), **pars):
    n = place(comp.create(kind, name), x, y)
    for i, src in enumerate(inputs):
        n.inputConnectors[i].connect(src)
    for k, v in pars.items():
        expr = isinstance(v, str) and v.startswith('=')
        setp(n, k, v[1:] if expr else v, expr=expr)
    return n


cin = comp.op('in_cam')

# Where the slit is (the right palm, else the left, else the middle), the drop's turn and how far the arms reach.
scb = node(textDAT, 'slit_callbacks', 1, 9)
scb.text = """
import math

def onCook(scriptOp):
    hands, body, ch = op('in_hands'), op('in_body'), op('in_ch')
    side = 21 if hands['on'][30] > 0.5 else 0 if hands['on'][9] > 0.5 else -1
    vertical = 1.0 if float(ch['dropenergy'] or 0) > 0.5 else 0.0
    centre = (hands['u'][side + 9] if vertical else hands['v'][side + 9]) if side >= 0 else 0.5
    reach = 0.0
    for s, w in ((11, 15), (12, 16)):
        if body['on'][s] > 0.5 and body['on'][w] > 0.5:
            reach = max(reach, math.hypot(body['tx'][w] - body['tx'][s], body['ty'][w] - body['ty'][s]))
    scriptOp.clear()
    for name, v in (('centre', centre), ('vertical', vertical), ('reach', reach), ('beat', float(ch['beat'] or 0))):
        scriptOp.appendChan(name)[0] = v
    return
"""
slit = node(scriptCHOP, 'slit', 2, 9, callbacks=scb.name)

# The frames: half size into a 64-frame Texture 3D TOP.
small = node(resolutionTOP, 'small', 2, 0, [cin], outputresolution='custom', resolutionw=W // 2, resolutionh=H // 2)
frames = node(texture3dTOP, 'frames', 3, 0, [small], type='texture3d', cachesize=64, step=1)

# The map: the distance from the slit, in bands (LINES), re-dealt on the beat (CHAOS), the live window round it (SIZE).
tmap = place(shader(comp, 'time_map', """
uniform vec4 uSlit;   // centre (0-1 along), vertical (0/1), beat, -
uniform vec4 uKnobs;  // lines, chaos, size, -
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
    float along = mix(vUV.t, vUV.s, uSlit.y);
    float bands = floor(mix(4.0, 40.0, uKnobs.x));
    float band = floor(along * bands);
    float d = max(abs((band + 0.5) / bands - uSlit.x) - 0.25 * uKnobs.z * 0.3, 0.0) * 1.8;
    d += (hash(vec2(band, floor(uSlit.z / 2.0))) - 0.5) * 0.6 * uKnobs.y;
    fragColor = vec4(vec3(clamp(d, 0.0, 1.0)), 1.0);
}
"""), 3, 1)
uniforms(tmap, [
    ('uSlit', ("op('slit')['centre']", "op('slit')['vertical']", "op('slit')['beat']", '0')),
    ('uKnobs', ('parent().par.Lines', 'parent().par.Chaos', 'parent().par.Size', '0')),
], [])

# The Time Machine: map black = now, white = up to 63 frames back (TRAILS, and the arms' reach).
scan = node(timemachineTOP, 'scan', 4, 0, [frames, tmap], blackoffset=0, blackoffsetunit='indices', whiteoffsetunit='indices',
            whiteoffset="=6 + 57 * min(1.0, 0.6 * parent().par.Trails + 1.4 * float(op('slit')['reach']))",
            outputresolution='custom', resolutionw=W, resolutionh=H)

# COLOUR: the lagging rows toward the accent (a Matte TOP on the map); INTENSITY: contrast.
mono = node(monochromeTOP, 'mono', 5, 1, [scan])
accent = node(constantTOP, 'accent', 5, 2, outputresolution='custom', resolutionw=W, resolutionh=H, colorr=ACCENT[0],
              colorg=ACCENT[1], colorb=ACCENT[2])
tinted = node(compositeTOP, 'tinted', 6, 1, [mono, accent], operand='multiply')
lagged = node(matteTOP, 'lagged', 6, 0, [scan, tinted, tmap])
coloured = node(crossTOP, 'coloured', 7, 0, [scan, lagged], cross='=parent().par.Colour')
final = node(levelTOP, 'final', 8, 0, [coloured], contrast='=1 + 0.4 * parent().par.Intensity')
comp.op('out1').inputConnectors[0].connect(final)
