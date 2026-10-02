"""THRESHOLD + PLEXUS (v3, a TouchDesigner network): the picture posterized to the palette's three stops (two Threshold
TOPs through Matte TOPs: background, accent, ink; the snare and the kick move the cuts), and over it a plexus: points
on the person (a GLSL node writes a 48 x 27 float TOP of their positions, TOP to POP) and on your joints and fingertips
(CHOP to POP), joined to their neighbours by a Proximity POP, drawn as lines and dots (Line MAT, ortho Render, glow());
the joints numbered (a GLSL node: digit()). Drop: the picture inverts for half a beat every 2 beats (never more).
The knobs: LINES how far the plexus reaches, INTENSITY the glow and the lines' brightness, SIZE the dots, CHAOS the
person's points jitter, COLOUR the cuts (more accent), TRAILS nothing yet. Recipe: S3's v1-2 THRESHOLD + PLEXUS look.
"""

INK, ACCENT, BG = ([f'=parent().par.{n}{c}' for c in 'rgb'] for n in ('Ink', 'Accent', 'Bg'))
CELLS = (48, 27)
CH = "float(op('in_ch')['{}'] or 0)"


def node(kind, name, x, y, inputs=(), **pars):
    n = place(comp.create(kind, name), x, y)
    for i, src in enumerate(inputs):
        n.inputConnectors[i].connect(src)
    for k, v in pars.items():
        expr = isinstance(v, str) and v.startswith('=')
        setp(n, k, v[1:] if expr else v, expr=expr)
    return n


def flat(name, x, y, color):
    return node(constantTOP, name, x, y, outputresolution='custom', resolutionw=W, resolutionh=H, colorr=color[0],
                colorg=color[1], colorb=color[2])


cin = comp.op('in_cam')

# The posterized picture: background under the lower cut, accent between, ink over the upper (COLOUR lowers the cuts).
mono = node(monochromeTOP, 'mono', 2, 0, [cin])
low = node(thresholdTOP, 'low', 3, 0, [mono], comparator='greater',
           threshold=f"=0.45 - 0.08 * {CH.format('snare')} - 0.1 * parent().par.Colour")
high = node(thresholdTOP, 'high', 3, 1, [mono], comparator='greater', threshold=f"=0.62 - 0.06 * {CH.format('kick')}")
bg, accent, ink = flat('bg', 2, 2, BG), flat('accent', 2, 3, ACCENT), flat('ink', 2, 4, INK)
cut1 = node(matteTOP, 'cut1', 4, 2, [bg, accent, low], mattechannel='luminance')
cut2 = node(matteTOP, 'cut2', 5, 2, [cut1, ink, high], mattechannel='luminance')
# The drop: inverted for the first half of every other beat (one flash every 2 beats at most).
inverted = node(levelTOP, 'inverted', 6, 3, [cut2], invert=1)
posterized = node(crossTOP, 'posterized', 6, 2, [cut2, inverted],
                  cross=f"=1 if {CH.format('dropenergy')} > 0.6 and {CH.format('beatphase')} < 0.5 and int({CH.format('beat')}) % 2 == 0 else 0")

# The points: the person's (a float TOP of positions, those off the person thrown far apart) and the joints' and tips'.
person_pts = place(shader(comp, 'person_pts', """
uniform vec4 uKnobs;  // chaos, -, -, seconds
void main() {
    vec2 uv = vUV.st;
    float aspect = %f;
    float on = step(0.5, person(uv)) * step(0.35, hash(floor(uv * uTDOutputInfo.res.zw)));
    vec2 j = (vec2(hash(uv + floor(uKnobs.w * 4.0)), hash(uv.yx + 3.0 + floor(uKnobs.w * 4.0))) - 0.5) * 0.02 * uKnobs.x;
    vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5) + j;
    // off the person: far away and far apart, so the Proximity POP never joins them
    fragColor = on > 0.5 ? vec4(p, 0.0, 1.0) : vec4(100.0 + uv.x * 400.0, 100.0 + uv.y * 400.0, 0.0, 1.0);
}
""" % (W / H), [cin], header=True), 3, 5)
setp(person_pts, 'resolutionw', CELLS[0])
setp(person_pts, 'resolutionh', CELLS[1])
setp(person_pts, 'format', 'rgba32float')
uniforms(person_pts, [('uKnobs', ('parent().par.Chaos', '0', '0', 'absTime.seconds'))], [])

jcb = node(textDAT, 'joints_callbacks', 3, 7)
jcb.text = """
PICKS = [('body', i) for i in (0, 11, 12, 13, 14, 15, 16, 23, 24)] + [('hands', s + t) for s in (0, 21) for t in (4, 8, 12, 16, 20)]

def onCook(scriptOp):
    live = [(op('in_' + part), i) for part, i in PICKS if op('in_' + part)['on'][i] > 0.5]
    scriptOp.clear()
    scriptOp.numSamples = max(1, len(live))
    tx, ty, tz = [scriptOp.appendChan(n) for n in ('tx', 'ty', 'tz')]
    for k, (c, i) in enumerate(live):
        tx[k], ty[k], tz[k] = c['tx'][i], c['ty'][i], 0.0
    if not live:
        tx[0], ty[0], tz[0] = 900.0, 900.0, 0.0  # nobody: one point far away
    return
"""
joints = node(scriptCHOP, 'joints', 4, 7, callbacks=jcb.name)

line_mat = node(lineMAT, 'line_mat', 6, 8, widthnear="=1 + 1.5 * parent().par.Intensity", widthfar="=1 + 1.5 * parent().par.Intensity",
                drawpoints=True, pointsizemultiplier='=2 + 6 * parent().par.Size', linenearcolorr=INK[0], linenearcolorg=INK[1],
                linenearcolorb=INK[2], linenearalpha='=0.5 + 0.5 * parent().par.Intensity', pointnearcolorr=ACCENT[0],
                pointnearcolorg=ACCENT[1], pointnearcolorb=ACCENT[2], pointnearalpha=1)
plex = place(bare_geo(comp, 'plex', line_mat), 5, 6)
from_top = plex.create(toptoPOP, 'person')
for k, v in dict(rgba='pos', input0top='../person_pts', input0attrscope='P', surftype='points').items():
    setp(from_top, k, v)
from_chop = plex.create(choptoPOP, 'joints')
for k, v in dict(chop='../joints', surftype='points', attrscope='P').items():
    setp(from_chop, k, v)
merged = plex.create(mergePOP, 'merged')
merged.inputConnectors[0].connect(from_top)
merged.inputConnectors[1].connect(from_chop)
near = plex.create(proximityPOP, 'near')
near.inputConnectors[0].connect(merged)
for k, v in dict(maxdist='=0.06 + 0.12 * parent(2).par.Lines', maxlinesperpoint=4, output='lines').items():
    expr = isinstance(v, str) and v.startswith('=')
    setp(near, k, v[1:] if expr else v, expr=expr)
near.render = near.display = True

cam = place(ortho(comp), 6, 6)
drawn = place(render(comp, 'drawn', 'plex', cam), 7, 5)
glowing = place(glow(comp, 'glow', drawn, '=0.4 + 1.2 * parent().par.Intensity'), 8, 5)

# The joints' numbers (a GLSL node: digit() beside each tracked joint and fingertip).
labels = place(shader(comp, 'labels', """
void main() {
    vec2 p = scr(vUV.st);
    float px = 1.0 / uTDOutputInfo.res.w;
    vec2 g = vec2(6.0, 10.0) * px;
    float n = 0.0;
    for (int i = 11; i < 17; i++) {
        if (!jointOn(i)) continue;
        vec2 o = scr(joint(i)) + vec2(10.0, 8.0) * px;
        n += digit(i / 10, (p - o) / g) + digit(i % 10, (p - o - vec2(g.x * 1.4, 0.0)) / g);
    }
    for (int s = 0; s < 2; s++) {
        if (!handOn(s)) continue;
        for (int t = 8; t < 21; t += 4) {
            int k = s * 21 + t;
            vec2 o = scr(handPt(s, t)) + vec2(8.0, 4.0) * px;
            n += digit(k / 10, (p - o) / g) + digit(k % 10, (p - o - vec2(g.x * 1.4, 0.0)) / g);
        }
    }
    float a = clamp(n, 0.0, 1.0);
    fragColor = TDOutputSwizzle(vec4(uPal2.rgb * a, a));
}
""", [cin], header=True), 8, 3)
uniforms(labels, [
    ('uHand', ("op('in_shapes')['hlon']", "op('in_shapes')['hron']", '0', '0')),
    ('uPal2', ('parent().par.Inkr', 'parent().par.Inkg', 'parent().par.Inkb', '1')),
], [('uBody', 'vec3', track['body'].path), ('uHands', 'vec2', track['hands'].path)])

over1 = node(overTOP, 'over1', 9, 4, [glowing, posterized])
over2 = node(overTOP, 'over2', 10, 4, [labels, over1])
comp.op('out1').inputConnectors[0].connect(over2)
