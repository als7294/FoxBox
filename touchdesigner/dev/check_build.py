"""Offline check of the v3 presets' build.py against the user's TouchDesigner build, with no TouchDesigner running (no
heavy slot): each build runs on mock operators, and it reports parameters the probe doesn't have, menu values it doesn't
list, operator types it didn't probe (their names go unchecked), Python syntax errors in parameter expressions, uniform
expressions and callback DATs, duplicate operator names, a build that raises, and whether out1 gets a picture.
Each callback's onCook also runs on mock tracking (both hands, one, nobody; numpy: engine/.venv/bin/python), after an
on_cmd's onCommand gets each gesture command (their stored state then cooks): what raises
is a warning (runtime:), the mock being a subset of TouchDesigner. GLSL, the
looks and TouchDesigner's own runtime still need a preview (dev/preview.cjs).

    python3 touchdesigner/dev/check_build.py              every preset with a build.py
    python3 touchdesigner/dev/check_build.py databody     just these (ids)

The probe is the newest td-*-params.json next to this file. Exit 1 on any problem."""
import json
import math
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OPS = json.loads(sorted(HERE.glob('td-*-params.json'))[-1].read_text())['ops']
FLAGS = {'render', 'display', 'nodeX', 'nodeY', 'viewer', 'bypass', 'lock'}


class Conn:
    def __init__(self, owner, i):
        self.owner, self.i, self.src = owner, i, None

    def connect(self, src):
        self.src = src


class Param:
    def __init__(self, node, name, kind):
        self.node, self.name, self.kind = node, name, kind
        self._mode, self._val, self._expr = None, None, None

    def eval(self):
        return 0.5

    @property
    def val(self):
        return self._val

    @val.setter
    def val(self, v):
        self._val = v
        # a menu of just '*' is a free-form pattern (a scope, channel names)
        if isinstance(self.kind, list) and self.kind not in ([], ['*']) and isinstance(v, str) and v not in self.kind:
            REPORT['menu'].append(f'{self.node.path}.{self.name}={v!r} (menu: {"|".join(self.kind[:10])})')

    @property
    def expr(self):
        return self._expr

    @expr.setter
    def expr(self, e):
        self._expr = e
        try:
            compile(e, '<expr>', 'eval')
        except SyntaxError as err:
            REPORT['syntax'].append(f'{self.node.path}.{self.name}: {err.msg}: {e[:90]}')

    @property
    def mode(self):
        return self._mode

    @mode.setter
    def mode(self, m):
        self._mode = m


class Pars:
    def __init__(self, node):
        object.__setattr__(self, '_node', node)

    def __getattr__(self, name):
        node = object.__getattribute__(self, '_node')
        known = OPS.get(node.kind)
        if known is None:  # an operator the probe doesn't cover: accept, flag the type once
            return node.params.setdefault(name, Param(node, name, None))
        if name not in known:
            return None
        return node.params.setdefault(name, Param(node, name, known[name]))

    def __setattr__(self, name, value):
        p = self.__getattr__(name)
        if p is None:
            REPORT['missing'].append(f"{object.__getattribute__(self, '_node').path}.{name} (direct)")
        else:
            p.val = value


class Node:
    def __init__(self, kind, name, parent=None):
        self.kind, self.name, self.parent = kind, name, parent
        self.path = f'{parent.path}/{name}' if parent else name
        self.par, self.params, self.children, self.text = Pars(self), {}, [], ''
        # a GLSL TOP takes 3 inputs (TouchDesigner 2025.33230 raised IndexError on a 4th: S1's ASCII BODY run)
        self.inputConnectors = [Conn(self, i) for i in range(3 if kind == 'glslTOP' else 8)]
        self.seq = type('Seq', (), {'vec': type('B', (), {'numBlocks': 0})(), 'array': type('B', (), {'numBlocks': 0})()})()
        if kind not in OPS and kind not in UNPROBED_OK:
            REPORT['unprobed'].add(kind)
        if parent is not None:
            if any(c.name == name for c in parent.children):
                REPORT['dup'].append(self.path)
            parent.children.append(self)

    def create(self, kind, name):
        return Node(kind, name, self)

    def op(self, name):
        return next((c for c in self.children if c.name == name), None)

    def destroy(self):
        self.parent.children.remove(self)

    def clear(self, *a, **k):  # a table DAT a build seeds
        pass

    def appendRow(self, *a, **k):
        pass

    def __setattr__(self, k, v):
        object.__setattr__(self, k, v)
        if k == 'text' and v and self.kind == 'textDAT' and ('def onCook' in v or 'def onCommand' in v):
            try:
                compile(v, self.path, 'exec')
                CALLBACKS.append(self)
            except SyntaxError as err:
                REPORT['syntax'].append(f'{self.path} (callbacks) line {err.lineno}: {err.msg}')


UNPROBED_OK = {'textDAT', 'inTOP', 'outTOP'}  # the mock's own inputs and out1

# foxbox_setup.py's own build helpers (shader, skeleton, instances, bare_geo and their constants), taken from the file
# itself so the check never drifts from what a build really gets (S1's patch); they run on the mocks below.
import ast  # noqa: E402

_setup = (HERE.parent / 'foxbox_setup.py').read_text()
_tree = ast.parse(re.sub(r'__[A-Z_]+__', '0', _setup))
_names = {'ortho', 'render', 'shader', 'glow', 'BONES', 'bare_geo', 'skeleton', 'SHAPES_SOP', 'instances', 'windows',
          'WINDOW_DESK', 'SQUARE_SOP'}
_nodes = [n for n in _tree.body if (isinstance(n, ast.FunctionDef) and n.name in _names)
          or (isinstance(n, ast.Assign) and any(getattr(t, 'id', None) in _names for t in n.targets))]
HELPERS_SRC = '\n'.join(ast.get_source_segment(_setup, n) for n in _nodes)
HELPERS = compile(HELPERS_SRC, 'foxbox_setup.py (helpers)', 'exec')
INPUTS = {'in_cam': 'inTOP', 'in_matte': 'inTOP', 'in_ch': 'selectCHOP', 'in_shapes': 'selectCHOP', 'in_body': 'selectCHOP',
          'in_hands': 'selectCHOP', 'in_face': 'selectCHOP', 'in_frame': 'selectCHOP', 'in_body_pts': 'choptoSOP',
          'in_hands_pts': 'choptoSOP', 'in_face_pts': 'choptoSOP', 'in_frame_pts': 'choptoSOP', 'out1': 'outTOP'}


def run(folder):
    global REPORT, CALLBACKS
    REPORT = {'missing': [], 'menu': [], 'syntax': [], 'dup': [], 'unprobed': set()}
    CALLBACKS = []
    src = (folder / 'build.py').read_text()
    if "'''" in src:
        REPORT['syntax'].append("build.py has ''' (it embeds in a Python string)")
    comp = Node('baseCOMP', 'p_' + folder.name)
    for name, kind in INPUTS.items():
        Node(kind, name, comp)

    def setp(node, name, value, expr=False):
        par = getattr(node.par, name, None)
        if par is None:
            REPORT['missing'].append(f'{node.path}.{name}')
            return
        if expr:
            par.expr = value
        else:
            par.val = value

    def ortho(parent, name='cam'):
        c = parent.create('cameraCOMP', name)
        for k, v in (('projection', 'ortho'), ('orthowidth', 1280 / 720), ('tz', 5)):
            setp(c, k, v)
        return c

    def render(parent, name, geometry, camera, lights=''):
        r = parent.create('renderTOP', name)
        for k, v in (('outputresolution', 'custom'), ('resolutionw', 1280), ('resolutionh', 720), ('camera', camera.name),
                     ('geometry', geometry), ('lights', lights)):
            setp(r, k, v)
        for g in geometry.split():
            if parent.op(g) is None:
                REPORT['missing'].append(f'{r.path}: geometry {g!r} not built')
        return r

    def glsl(parent, name, code, inputs=(), header=False):
        d = parent.create('textDAT', name + '_frag')
        d.text = code
        g = parent.create('glslTOP', name)
        for i, s in enumerate(inputs):
            g.inputConnectors[i].connect(s)
        return g

    def uniforms(g, vecs, arrays):
        for name, values in vecs:
            for v in values:
                if isinstance(v, str):
                    try:
                        compile(v, '<uniform>', 'eval')
                    except SyntaxError as err:
                        REPORT['syntax'].append(f'{g.path} uniform {name}: {err.msg}: {v[:80]}')

    kinds = set(re.findall(r'\b([a-z0-9]+(?:TOP|SOP|CHOP|MAT|COMP|POP|DAT))\b', src + HELPERS_SRC))
    env = {k: k for k in kinds}
    env.update(comp=comp, preset=json.loads((folder / 'preset.json').read_text()), setp=setp,
               place=lambda n, x, y: n, W=1280, H=720, HEADER='')
    exec(HELPERS, env)  # the real shader / skeleton / instances / bare_geo, on the mocks
    env.update(ortho=ortho, render=render, glsl=glsl, uniforms=uniforms,
               track={k: Node('scriptCHOP', k) for k in ('points', 'body', 'hands', 'frame', 'shapes')}, math=math,
               absTime=type('T', (), {'frame': 1, 'seconds': 0.0})(), ParMode=type('PM', (), {'EXPRESSION': 1}))
    try:
        exec(compile(src, str(folder / 'build.py'), 'exec'), env)
    except Exception as e:  # a build that raises shows only the camera in FoxBox
        REPORT['syntax'].append(f'RAISES: {type(e).__name__}: {e}')
    out = comp.op('out1')
    connected = out is not None and out.inputConnectors[0].src is not None
    print(f"== {folder.name}: out1 {'connected' if connected else 'NOT CONNECTED'}; {len(comp.children)} operators")
    for k in ('missing', 'menu', 'syntax', 'dup'):
        for line in REPORT[k]:
            print(f'   {k}: {line}')
    if REPORT['unprobed']:
        print(f"   unprobed (names unchecked): {' '.join(sorted(REPORT['unprobed']))}")
    run_callbacks(folder.name)
    return connected and not any(REPORT[k] for k in ('missing', 'menu', 'syntax', 'dup'))


class AnyPar:
    """Any parameter of a mock: eval() 0.5, pulse() does nothing."""

    def __getattr__(self, k):
        return type('V', (), {'eval': lambda s: 0.5, 'pulse': lambda s: None, 'val': 0.5})()


class Owner:
    """parent() for a callback: the knobs, and the preset COMP's storage (shared by its callbacks and on_cmd)."""

    def __init__(self):
        self.par, self.storage = AnyPar(), {}

    def store(self, k, v):
        self.storage[k] = v

    def fetch(self, k, default=None, storeDefault=False):
        return self.storage.setdefault(k, default) if storeDefault else self.storage.get(k, default)


# the gesture commands an on_cmd gets (PROD's GestureMap; x y w h the picture's 0-1, y down)
COMMANDS = (('new_window', [0.2, 0.2, 0.3, 0.3]), ('portal', [0.4, 0.6]), ('pluck', [0.5, 0.5]), ('clear', []),
            ('randomize', []))


class Chan:
    def __init__(self, vals):
        self.vals = list(vals)

    def __getitem__(self, i):
        return self.vals[i]

    def __setitem__(self, i, v):
        self.vals += [0.0] * (i + 1 - len(self.vals))
        self.vals[i] = float(v)

    def __float__(self):
        return float(self.vals[0])


class MockCHOP:
    """An in_* (or any CHOP a callback reads): 42 samples of tx ty u v on, any other channel a constant; read as a TOP
    (`top`: the build made a TOP of that name) its pixels, as a table DAT a few rows of 0.5."""

    def __init__(self, rnd, hands, top=False):
        n, self.top = 42, top
        on = [1.0 if (i < 21 and hands > 0) or (i >= 21 and hands > 1) else 0.0 for i in range(n)]
        self.data = {'tx': [rnd.uniform(-0.8, 0.8) for _ in range(n)], 'ty': [rnd.uniform(-0.45, 0.45) for _ in range(n)],
                     'u': [rnd.random() for _ in range(n)], 'v': [rnd.random() for _ in range(n)], 'on': on}
        self.k = 0.7 if hands else 0.0

    numSamples = 42
    numRows = 3  # read as a table DAT: a header row and two
    par = AnyPar()

    def __getitem__(self, name):
        if isinstance(name, tuple):  # a table DAT's cell, t[row, col]
            return type('Cell', (), {'val': '0.5', '__float__': lambda c: 0.5, '__str__': lambda c: '0.5'})()
        return Chan(self.data.get(name, [self.k] * 42))

    def __setitem__(self, key, value):
        pass

    def deleteRow(self, *a):
        pass

    def clear(self, *a, **k):
        pass

    def appendRow(self, *a):
        pass

    def row(self, *a):
        return [self[0, 0]]

    def chans(self):
        return [type('C', (), {'name': k})() for k in self.data]

    def numpyArray(self):
        import numpy as np
        if self.top:  # a TOP's pixels: rows (from the bottom) x columns x RGBA
            return np.full((36, 64, 4), self.k, dtype=np.float32)
        return np.array([self.data[k] for k in self.data])


class Point:
    x = y = z = 0.0


class Vertex:
    def __init__(self):
        self.point = Point()


class ScriptOp:
    """A Script CHOP / SOP for a callback: its channels no longer than numSamples, of numbers."""

    def __init__(self, name, inp):
        self.name, self.numSamples, self.chans, self.storage = name, 1, [], {}  # a Script CHOP starts at 1 sample
        self.inputs = [inp]

    def clear(self):
        self.chans = []

    def appendChan(self, name):
        c = Chan([0.0] * self.numSamples)
        self.chans.append((name, c))
        return c

    def appendPoly(self, n, closed=True, addPoints=True):
        return [Vertex() for _ in range(n)]

    def store(self, k, v):
        self.storage[k] = v

    def fetch(self, k, default=None, storeDefault=False):
        return self.storage.setdefault(k, default) if storeDefault else self.storage.get(k, default)


def run_callbacks(name):
    """Each callback DAT's onCook, three times (both hands, one, nobody), as TouchDesigner would call it; what raises is
    printed (runtime:), a warning only."""
    try:
        import numpy  # noqa: F401
    except ImportError:
        print('   (runtime: skipped, no numpy: run with engine/.venv/bin/python)')
        return
    import random
    owner = Owner()
    for dat in sorted(CALLBACKS, key=lambda d: 'def onCook' in d.text):  # the commands first: their state then cooks
        for hands in (2, 1, 0):
            rnd = random.Random(hands)
            def op(n, r=rnd, h=hands, here=dat.parent):
                found = here.op(n)
                return MockCHOP(r, h, top=found is not None and found.kind.endswith('TOP'))
            env = {'op': op, 'parent': lambda *a: owner,
                   'absTime': type('T', (), {'frame': 7, 'seconds': 1.25})(), 'me': dat}
            sop = ScriptOp(dat.path.split('/')[-1].replace('_callbacks', ''), MockCHOP(rnd, hands))
            try:
                exec(compile(dat.text, dat.path, 'exec'), env)
                if 'onCommand' in env:
                    for name, args in COMMANDS:
                        env['onCommand'](name, list(args))
                    break
                for _ in range(2):  # twice: storage carried over
                    env['onCook'](sop)
                bad = [n for n, c in sop.chans if len(c.vals) > sop.numSamples or not all(isinstance(v, float) for v in c.vals)]
                if bad:
                    raise ValueError(f'channels {bad}: more than numSamples={sop.numSamples}, or not floats')
            except Exception as e:  # a warning: the mock is a subset of TouchDesigner (a TOP's pixels, a DAT's rows)
                print(f'   runtime: {dat.path} ({hands} hands): {type(e).__name__}: {e}')
                break


PRESETS = HERE.parent / 'presets'

ids = sys.argv[1:] or sorted(p.parent.name for p in PRESETS.glob('*/build.py'))
ok = all([run(PRESETS / i) for i in ids])
sys.exit(0 if ok else 1)
