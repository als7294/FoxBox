# FoxBox product icons (S3): one Big Sur squircle family (a deep near-black body, the product colour glowing behind a
# coloured fox). (A) the FoxBox mark's head in three colours; (B) a full-body fox per product. Writes the SVG sources.
import math, os
OUT = os.path.join(os.path.dirname(__file__), '..')

def squircle(x, y, s, n=5.0, pts=240):
    """Apple's continuous-corner body, as a superellipse |x|^n + |y|^n = 1 over the s x s square at (x, y)."""
    c, r = (x + s / 2, y + s / 2), s / 2
    d = []
    for i in range(pts):
        t = 2 * math.pi * i / pts
        ct, st = math.cos(t), math.sin(t)
        d.append(f"{'M' if i == 0 else 'L'}{c[0] + r * math.copysign(abs(ct) ** (2 / n), ct):.1f} {c[1] + r * math.copysign(abs(st) ** (2 / n), st):.1f}")
    return ' '.join(d) + ' Z'

BODY = squircle(100, 100, 824)

# (A) the FoxBox mark's head (foxbox-icon.svg, its 512 box), solid, with its two eye notches
HEAD = 'M96 56 L204 172 L308 172 L416 56 L452 296 L256 470 L60 296 Z'
HEAD_EYES = 'M140 250 L248 290 L226 330 L176 306 Z M372 250 L264 290 L286 330 L336 306 Z'

# (B) full-body foxes, angular like the mark (a 512 box, facing right), each with an eye notch
TAIL = 'L196 452 L126 458 L66 436 L36 384 L44 322 L78 362 L116 398 L170 410 L168 330 L206 246'
BODIES = {
    # sitting upright, tall ears, a sharp snout, the big tail wrapped round the front
    'strings': ('M318 40 L346 112 L382 140 L430 170 L380 186 L340 198 L322 232 L340 268 L354 350 L352 428 L380 452 L318 452 '
                'L314 392 L296 452 ' + TAIL + ' L250 170 L276 118 L284 52 L302 104 Z', 'M350 138 L374 146 L354 154 Z', (226, 214)),
    # sitting, the head thrown back, muzzle to the sky, ears laid back: singing
    'voice': ('M428 34 L410 62 L404 76 L366 118 L352 200 L356 300 L352 428 L380 452 L318 452 L314 392 L296 452 ' + TAIL +
              ' L250 170 L280 112 L248 84 L302 90 L332 66 L382 44 Z', 'M346 78 L368 74 L356 92 Z', (226, 236)),
    # low and stretched, head forward and down, the bushy tail held straight back: stalking
    'visuals': ('M482 298 L440 316 L412 322 L392 340 L396 390 L420 404 L376 404 L368 352 L300 350 L276 370 L262 404 L220 404 '
                'L238 372 L226 330 L190 322 L130 332 L70 324 L18 300 L74 282 L140 280 L196 278 L260 266 L330 262 L372 258 '
                'L396 262 L404 250 L414 204 L436 250 L448 262 Z', 'M440 276 L460 280 L446 290 Z', (226, 160)),
}

COLOUR = {  # the fox's fill (top → bottom) and the glow behind it
    'strings': (('#FFC08A', '#F2701F', '#E2471F'), '#F2701F'),
    'voice': (('#FFFFFF', '#F2F6FA', '#DCE6F0'), '#5A7BE8'),   # arctic white; its edge glows teal → violet
    'visuals': (('#FF8AC6', '#F0359A', '#C21680'), '#E8288F'),
}
TITLE = {'strings': 'FoxBox Strings', 'voice': 'FoxBox Voice', 'visuals': 'FoxBox Visuals'}

def mix(p, q, t):
    """Hex colour p moved t of the way to q."""
    rgb = lambda h: [int(h[i:i + 2], 16) for i in (1, 3, 5)]
    return '#' + ''.join(f'{round(x + (y - x) * t):02X}' for x, y in zip(rgb(p), rgb(q)))

def icon(k, fox, eyes, box):
    (a, b, c), glow = COLOUR[k]
    top = mix('#1A1512', glow, 0.10)  # the user's pick: a gentle diagonal, ~10% product colour top-left, near-black bottom-right
    x, y, s = box  # where the 512 box goes
    edge = ''
    if k == 'voice':  # the arctic fox's teal → violet edge glow
        edge = f'''
    <g transform="translate({x} {y}) scale({s / 512})" filter="url(#edgeblur)" opacity="0.6"><path d="{fox}" fill="url(#aurora)"/></g>
    <g transform="translate({x} {y}) scale({s / 512})"><path d="{fox}" fill="none" stroke="url(#aurora)" stroke-width="{10 * 512 / s:.1f}" stroke-linejoin="round" stroke-opacity="0.85"/></g>'''
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <title>{TITLE[k]}</title>
  <defs>
    <linearGradient id="night" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{top}"/><stop offset="0.6" stop-color="#110D0B"/><stop offset="1" stop-color="#090706"/></linearGradient>
    <radialGradient id="halo" cx="0.5" cy="0.56" r="0.5"><stop offset="0" stop-color="{glow}" stop-opacity="0.27"/><stop offset="1" stop-color="{glow}" stop-opacity="0"/></radialGradient>
    <linearGradient id="fox" x1="0.2" y1="0" x2="0.8" y2="1"><stop offset="0" stop-color="{a}"/><stop offset="0.55" stop-color="{b}"/><stop offset="1" stop-color="{c}"/></linearGradient>
    <linearGradient id="aurora" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2DE0C8"/><stop offset="0.5" stop-color="#3E8FE0"/><stop offset="1" stop-color="#7A4FE8"/></linearGradient>
    <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.08"/><stop offset="0.3" stop-color="#fff" stop-opacity="0.03"/><stop offset="0.7" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <linearGradient id="rim" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.22"/><stop offset="1" stop-color="#fff" stop-opacity="0.03"/></linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity="0.35"/></filter>
    <filter id="edgeblur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="9"/></filter>
    <mask id="eyes"><rect width="512" height="512" fill="#fff"/><path d="{eyes}" fill="#000"/></mask>
    <clipPath id="body"><path d="{BODY}"/></clipPath>
  </defs>
  <path d="{BODY}" fill="url(#night)" filter="url(#shadow)"/>
  <g clip-path="url(#body)">
    <rect x="100" y="100" width="824" height="824" fill="url(#halo)"/>
    <rect x="100" y="100" width="824" height="824" fill="url(#gloss)"/>{edge}
    <g transform="translate({x} {y}) scale({s / 512})"><path d="{fox}" fill="url(#fox)" mask="url(#eyes)"/></g>
  </g>
  <path d="{BODY}" fill="none" stroke="url(#rim)" stroke-width="3"/>
</svg>
'''

def bare(k, fox, eyes):
    """The fox alone (the home page's roadmap blocks): transparent, a tight viewBox, the product colour (the Voice fox
    keeps its teal → violet edge glow)."""
    import re
    nums = [float(v) for v in re.findall(r'-?\d+(?:\.\d+)?', fox)]
    xs, ys = nums[0::2], nums[1::2]
    pad = 26 if k == 'voice' else 6
    vb = f'{min(xs) - pad:.0f} {min(ys) - pad:.0f} {max(xs) - min(xs) + 2 * pad:.0f} {max(ys) - min(ys) + 2 * pad:.0f}'
    (a, b, c), _ = COLOUR[k]
    edge = (f'<path d="{fox}" fill="url(#aurora)" filter="url(#edgeblur)" opacity="0.6"/>\n  <path d="{fox}" fill="none" stroke="url(#aurora)" '
            f'stroke-width="9" stroke-linejoin="round" stroke-opacity="0.85"/>\n  ') if k == 'voice' else ''
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}">
  <title>{TITLE[k]}</title>
  <defs>
    <linearGradient id="fox" x1="0.2" y1="0" x2="0.8" y2="1"><stop offset="0" stop-color="{a}"/><stop offset="0.55" stop-color="{b}"/><stop offset="1" stop-color="{c}"/></linearGradient>
    <linearGradient id="aurora" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2DE0C8"/><stop offset="0.5" stop-color="#3E8FE0"/><stop offset="1" stop-color="#7A4FE8"/></linearGradient>
    <filter id="edgeblur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="8"/></filter>
    <mask id="eyes" maskUnits="userSpaceOnUse" x="-100" y="-100" width="712" height="712"><rect x="-100" y="-100" width="712" height="712" fill="#fff"/><path d="{eyes}" fill="#000"/></mask>
  </defs>
  {edge}<path d="{fox}" fill="url(#fox)" mask="url(#eyes)"/>
</svg>
'''

for opt in ('A', 'B'):
    os.makedirs(os.path.join(OUT, 'bare', opt), exist_ok=True)

for k in COLOUR:
    open(os.path.join(OUT, 'bare', 'A', f'fox-{k}.svg'), 'w').write(bare(k, HEAD, HEAD_EYES))
    open(os.path.join(OUT, 'bare', 'B', f'fox-{k}.svg'), 'w').write(bare(k, BODIES[k][0], BODIES[k][1]))
    open(os.path.join(OUT, f'foxbox-{k}-a.svg'), 'w').write(icon(k, HEAD, HEAD_EYES, (236, 230, 552)))
    fox, eye, (bx, by) = BODIES[k]
    open(os.path.join(OUT, f'foxbox-{k}-b.svg'), 'w').write(icon(k, fox, eye, (bx, by, 572)))
print('ok')
