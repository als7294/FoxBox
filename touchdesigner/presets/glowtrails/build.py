"""GLOW TRAILS (v3, a TouchDesigner network): a Feedback TOP loop. Each frame the person (the camera through the matte),
the matte's edge in the accent (Edge TOP) and sparklers on the wrists and fingertips (instanced discs, Render TOP) go
over last frame's picture, which drifts up and in (Transform TOP), softens (Blur TOP) and fades (Level TOP, a little
subtracted so 8-bit trails reach black), the loop at half size; Bloom (half size) on top.
The knobs: TRAILS how long the trails stay, CHAOS the drift's swirl, INTENSITY the edge and the glow (and a flare on
each beat: once a beat at most), SIZE the sparks, LINES a faint line down the arms and fingers, COLOUR the person's
colour under the glow. Recipe: TouchDesigner's feedback trails (DBraun's feedback_TOP_blur / over examples).
"""

INK, ACCENT = [f'=parent().par.Ink{c}' for c in 'rgb'], [f'=parent().par.Accent{c}' for c in 'rgb']


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


cin, matte = comp.op('in_cam'), comp.op('in_matte')

# This frame: the person (COLOUR: colour to grey), the matte's edge in the accent, sparks and limbs.
grey = node(monochromeTOP, 'grey', 2, 0, [cin])
colour = node(crossTOP, 'colour', 3, 0, [grey, cin], cross='=parent().par.Colour')
lift = node(levelTOP, 'lift', 2, 1, [matte], outlow=0.08)
person = node(compositeTOP, 'person', 4, 0, [colour, lift], operand='multiply')
edge = node(edgeTOP, 'edge', 2, 2, [matte], strength='=2 + 4 * parent().par.Intensity')
edge_col = node(compositeTOP, 'edge_col', 3, 2, [edge, flat('accent', 2, 3, ACCENT)], operand='multiply')

spark_mat = node(constantMAT, 'spark_mat', 5, 7, colorr=ACCENT[0], colorg=ACCENT[1], colorb=ACCENT[2])
tips = [('body', 15), ('body', 16)] + [('hands', s + t) for s in (0, 21) for t in (4, 8, 12, 16, 20)]
sparks = place(instances(comp, 'sparks', tips, '(0.004 + 0.012 * parent().par.Size.eval()) * (1.6 if k < 2 else 1.0)',
                         spark_mat), 3, 6)
limb_mat = node(lineMAT, 'limb_mat', 5, 8, widthnear=2, widthfar=2, drawpoints=False, linenearcolorr=INK[0],
                linenearcolorg=INK[1], linenearcolorb=INK[2], linenearalpha='=0.6 * parent().par.Lines')
limbs = place(skeleton(comp, 'limbs', limb_mat, ('body', 'hands')), 4, 6)
cam = place(ortho(comp), 5, 6)
drawn = place(render(comp, 'drawn', 'sparks limbs', cam), 5, 5)
glows = node(compositeTOP, 'glows', 5, 2, [edge_col, drawn], operand='add')
flare = node(levelTOP, 'flare', 6, 2, [glows],
             brightness1="=1 + parent().par.Intensity * (1 - float(op('in_ch')['beatphase'] or 0)) ** 6")
now = node(compositeTOP, 'now', 7, 1, [person, flare], operand='add')

# The loop, at half size (the cook budget): last frame drifting up and in (CHAOS swirls it), blurred, faded (TRAILS),
# less a little; the max with now. Shown: now at full size over the trails.
now_half = node(resolutionTOP, 'now_half', 7, 2, [now], outputresolution='half')
last = node(feedbackTOP, 'last', 7, 3, [now_half], top='trails')
drift = node(transformTOP, 'drift', 8, 3, [last], tunit='fraction', ty=0.002, sx=0.997, sy=0.997,
             rotate='=parent().par.Chaos * 0.6 * math.sin(absTime.seconds * 0.7)')
soft = node(blurTOP, 'soft', 9, 3, [drift], size=2)
fade = node(levelTOP, 'fade', 10, 3, [soft], brightness1='=0.8 + 0.18 * parent().par.Trails')
floor_ = node(constantTOP, 'floor', 10, 4, outputresolution='custom', resolutionw=W, resolutionh=H, colorr=0.006,
              colorg=0.006, colorb=0.006)
decay = node(compositeTOP, 'decay', 11, 3, [fade, floor_], operand='subtract')
trails = node(compositeTOP, 'trails', 11, 2, [now_half, decay], operand='maximum')
shown = node(compositeTOP, 'shown', 11, 1, [now, trails], operand='maximum')
glowing = place(glow(comp, 'glow', shown, '=0.3 + 1.2 * parent().par.Intensity'), 12, 1)
comp.op('out1').inputConnectors[0].connect(glowing)
