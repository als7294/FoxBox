"""WINDOW MOSAIC (v3, a TouchDesigner network): the camera cut into small desktop windows on a grid. A Script CHOP lays
the grid out each frame: a window is up where the person is (the matte, sampled small), along your arms (the skeleton's
bones) or picked at random on the beat; each pops in on the beat; your hands push the windows near them away. S3's
windows() helper draws them (instanced fills as a mask, title bars, close boxes and outlines through a Render TOP) and
WINDOW_DESK puts the camera through them over the room. A drop doubles the grid.
The knobs: SIZE the cells (bigger: fewer), CHAOS the random windows, INTENSITY the pop, COLOUR the camera's colour in the
windows, TRAILS how much of the room shows, LINES the windows along the arms. Recipe: S3's v1-2 WINDOW MOSAIC look.
"""


def node(kind, name, x, y, inputs=(), **pars):
    n = place(comp.create(kind, name), x, y)
    for i, src in enumerate(inputs):
        n.inputConnectors[i].connect(src)
    for k, v in pars.items():
        expr = isinstance(v, str) and v.startswith('=')
        setp(n, k, v[1:] if expr else v, expr=expr)
    return n


matte = comp.op('in_matte')
small = node(resolutionTOP, 'matte_small', 2, 3, [matte], outputresolution='custom', resolutionw=32, resolutionh=18)

gcb = node(textDAT, 'grid_callbacks', 2, 5)
gcb.text = f"""
import math
import numpy as np
ASPECT = {W / H}
BONES = [(11, 12), (11, 13), (13, 15), (12, 14), (14, 16), (11, 23), (12, 24)]

def chans(c):
    names = [ch.name for ch in c.chans()]
    arr = c.numpyArray()
    return {{n: arr[i] for i, n in enumerate(names)}}

def onCook(scriptOp):
    par, ch = parent().par, op('in_ch')
    body, hands = chans(op('in_body')), chans(op('in_hands'))
    drop = float(ch['dropenergy'] or 0) > 0.5
    cols = int(round((14 - 8 * par.Size.eval()) * (1.5 if drop else 1.0)))
    rows = max(3, int(round(cols / ASPECT)))
    beat, phase, kick = float(ch['beat'] or 0), float(ch['beatphase'] or 0), float(ch['kick'] or 0)
    pop = 1.0 - par.Intensity.eval() * 0.4 * (1.0 - min(1.0, phase / 0.25))  # in on the beat
    cw, chh = ASPECT / cols, 1.0 / rows
    c, r = np.meshgrid(np.arange(cols), np.arange(rows))  # rows up from the bottom
    x, y = (c + 0.5) * cw - ASPECT / 2, (r + 0.5) * chh - 0.5
    m = op('matte_small').numpyArray()
    up = np.zeros(c.shape, bool) if m is None else m[((r + 0.5) / rows * m.shape[0]).astype(int), ((c + 0.5) / cols * m.shape[1]).astype(int), 0] > 0.5
    if par.Lines.eval() > 0.15:  # along the arms
        for a, b in BONES:
            if body['on'][a] > 0.5 and body['on'][b] > 0.5:
                ax, ay, dx, dy = body['tx'][a], body['ty'][a], body['tx'][b] - body['tx'][a], body['ty'][b] - body['ty'][a]
                t = np.clip(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy or 1e-9), 0.0, 1.0)
                up |= np.hypot(x - ax - t * dx, y - ay - t * dy) < 0.6 * cw
    lucky = (np.sin((c + 17 * r) * 127.1 + math.floor(beat) * 311.7) * 43758.5453) % 1.0
    up |= lucky < (0.12 + 0.3 * kick) * par.Chaos.eval()
    for i in (9, 30):  # the hands push the windows near them away
        if hands['on'][i] > 0.5:
            px, py = hands['tx'][i], hands['ty'][i]
            d = np.hypot(x - px, y - py) + 1e-6
            f = 0.12 * np.exp(-(d / 0.18) ** 2)
            x, y = x + (x - px) / d * f, y + (y - py) / d * f
    scriptOp.clear()
    scriptOp.numSamples = cols * rows
    for n, v in (('tx', x), ('ty', y), ('sx', np.where(up, cw * 0.86 * pop, 0.0)), ('sy', np.where(up, chh * 0.72 * pop, 0.0))):
        scriptOp.appendChan(n).vals = v.ravel().tolist()
    return
"""
grid = node(scriptCHOP, 'grid', 3, 5, callbacks=gcb.name)
mask, chrome = windows(comp, 'win', grid, bar=0.022)
place(mask, 5, 4)
place(chrome, 5, 3)
desk = place(shader(comp, 'desk', WINDOW_DESK, [comp.op('in_cam'), mask, chrome]), 6, 3)
uniforms(desk, [
    ('uBg', ('parent().par.Bgr', 'parent().par.Bgg', 'parent().par.Bgb', '1')),
    ('uKnobs', ('0.1 + 0.6 * parent().par.Trails', 'parent().par.Colour', '0', '0')),
], [])
comp.op('out1').inputConnectors[0].connect(desk)
