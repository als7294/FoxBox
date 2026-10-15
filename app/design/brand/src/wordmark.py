# The "FoxBox Strings" wordmark (option C, "Pluck", the user picked it 2026-10-15) and the two options not taken, as
# outlined SVG: Geist shaped by HarfBuzz, outlines from the variable font. Needs fonttools, brotli and uharfbuzz.
# Usage: python wordmark.py <geist-variable.woff2> <outdir>   (C is ../foxbox-strings-wordmark.svg)
import io, sys
import uharfbuzz as hb
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.transformPen import TransformPen
from fontTools.varLib.instancer import instantiateVariableFont

src, out = sys.argv[1], sys.argv[2]
INK, INK2, ACC = '#F6EFE6', '#B5A798', '#F2701F'
base = TTFont(src)
buf = io.BytesIO(); base.flavor = None; base.save(buf); TTF = buf.getvalue()
UPEM = base['head'].unitsPerEm
_inst = {}

def inst(wght):
    if wght not in _inst:
        _inst[wght] = instantiateVariableFont(TTFont(io.BytesIO(TTF)), {'wght': wght})
    return _inst[wght]

def run(text, wght, size, track=0.0, x=0.0, y=0.0):
    """Shape `text` at weight/size; return (svg path d, advance end x, glyph boxes) with the baseline at y (y down)."""
    face = hb.Face(TTF); font = hb.Font(face); font.set_variations({'wght': wght})
    b = hb.Buffer(); b.add_str(text); b.guess_segment_properties(); hb.shape(font, b, {'kern': True, 'liga': True})
    tt = inst(wght); gs = tt.getGlyphSet(); order = tt.getGlyphOrder()
    s = size / UPEM; pen = SVGPathPen(gs); boxes = []
    for info, pos in zip(b.glyph_infos, b.glyph_positions):
        name = order[info.codepoint]
        t = (s, 0, 0, -s, x + pos.x_offset * s, y - pos.y_offset * s)
        gs[name].draw(TransformPen(pen, t))
        bp = BoundsPen(gs); gs[name].draw(bp)
        boxes.append((name, x, bp.bounds and tuple(v * s for v in bp.bounds)))
        x += pos.x_advance * s + track * size
    return pen.getCommands(), x - track * size, boxes

def svg(w, h, body, title, top=0.0):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 {top:.1f} {w:.1f} {h - top:.1f}" width="{w:.0f}" height="{h - top:.0f}" '
            f'role="img" aria-label="FoxBox Strings"><title>{title}</title>{body}</svg>\n')

# A · TAUT: one line, FoxBox heavy + Strings light, a taut string under it, plucked once (the orange point)
S = 100
d1, x1, _ = run('FoxBox', 800, S, -0.035, 0, 100)
d2, x2, _ = run('Strings', 380, S, -0.015, x1 + 0.24 * S, 100)
W = x2 + 4; ly = 100 + 0.27 * S; px = W * 0.63; dip = 0.075 * S
string = (f'<path d="M2 {ly:.1f} L{px:.1f} {ly + dip:.1f} L{W - 2:.1f} {ly:.1f}" fill="none" stroke="{INK}" stroke-opacity=".55" '
          f'stroke-width="{0.03 * S:.1f}" stroke-linecap="round" stroke-linejoin="round"/>'
          f'<circle cx="{px:.1f}" cy="{ly + dip:.1f}" r="{0.055 * S:.1f}" fill="{ACC}"/>')
A = svg(W, ly + dip + 0.09 * S, f'<path d="{d1}" fill="{INK}"/><path d="{d2}" fill="{INK}"/>{string}', 'FoxBox Strings · Taut', 100 - 0.76 * S)

# B · FIVE STRINGS: stacked; "Strings" runs on, as five taut lines, to FoxBox's width (the middle one orange)
S1, S2 = 100, 52
d1, x1, _ = run('FoxBox', 800, S1, -0.04, 0, 100)
d2, x2, bx = run('Strings', 500, S2, 0.0, 2, 100 + 0.74 * S1)
xh = 0.53 * S2; y0 = 100 + 0.74 * S1; a = x2 + 0.32 * S2; b_ = x1 - 2
lines = ''.join(f'<line x1="{a:.1f}" x2="{b_:.1f}" y1="{y0 - xh * k / 4:.1f}" y2="{y0 - xh * k / 4:.1f}" stroke="{ACC if k == 2 else INK}" '
                f'stroke-opacity="{1 if k == 2 else .5}" stroke-width="{0.035 * S2:.2f}" stroke-linecap="round"/>' for k in range(5))
B = svg(x1 + 2, y0 + 0.24 * S2, f'<path d="{d1}" fill="{INK}"/><path d="{d2}" fill="{INK}"/>{lines}', 'FoxBox Strings · Five strings', 100 - 0.76 * S1)

# C · PLUCK: one weight, Strings in the second ink, the i's dot is the pluck (orange, with a ripple)
S = 100
d1, x1, _ = run('FoxBox', 720, S, -0.045, 0, 100)
d2, x2, bx = run('Strings'.replace('i', 'ı'), 720, S, -0.03, x1 + 0.22 * S, 100)
dotless = next(b for b in bx if b[0] == 'dotlessi')
cx = (dotless[2][0] + dotless[2][2]) / 2 + dotless[1]; stem = dotless[2][2] - dotless[2][0]
cy = 100 - 0.70 * S; r = stem * 0.62
ripple = ''.join(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r * k:.1f}" fill="none" stroke="{ACC}" stroke-opacity="{o}" stroke-width="{0.018 * S:.1f}"/>'
                 for k, o in ((1.9, .55), (2.8, .25)))
C = svg(x2 + 4, 100 + 0.24 * S, f'<path d="{d1}" fill="{INK}"/><path d="{d2}" fill="{INK2}"/>'
        f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r:.1f}" fill="{ACC}"/>{ripple}', 'FoxBox Strings · Pluck', min(100 - 0.76 * S, cy - 2.8 * r - 2))

for n, s in (('A-taut', A), ('B-five-strings', B), ('C-pluck', C)):
    open(f'{out}/foxbox-strings-{n}.svg', 'w').write(s)
print('ok')
