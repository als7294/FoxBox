// FoxBox 2.0 onboarding — heavy motion-graphic tutorial. One tree, keyed to T / CUES.
const MOTION = { enter: Easing.easeOutCubic, draw: Easing.easeInOutCubic, pop: Easing.easeOutBack };
const OR = '#FF4D2E', INK = '#F6EFE6', SUB = '#C9BBAC', BG = '#0B0806', ICE = '#9FD4FF';
const FONT = "Geist, 'Helvetica Neue', Helvetica, sans-serif", MONO = "'Geist Mono', ui-monospace, monospace";
const lerp = (a, b, k) => a + (b - a) * k, cl = v => Math.max(0, Math.min(1, v));
function useA() { const { T } = useComposition(); return (from, to, start, end, ease) => animate({ from, to, start, end, ease: ease || MOTION.enter })(T); }
const anim = (t, from, to, start, end, ease) => animate({ from, to, start, end, ease: ease || MOTION.enter })(t);

// ---------- fox mark ----------
const HEAD = '255,203 428,388 596,388 769,203 824,573 512,745 200,573', CHEV = '297,677 512,797 727,677 512,867';
const CUTS = [['281,280 415,418 309,468', 335, 390], ['743,280 609,418 715,468', 689, 390], ['326,515 498,578 464,642 384,604', 420, 580], ['698,515 526,578 560,642 640,604', 604, 580]];
function FoxMark({ size, t0 }) {
  const A = useA();
  const tileS = A(.5, 1, t0, t0 + .8, MOTION.pop), tileO = A(0, 1, t0, t0 + .35), headS = A(.3, 1, t0 + .3, t0 + 1, MOTION.pop), cut = A(0, 1, t0 + .8, t0 + 1.3, MOTION.pop), chev = A(120, 0, t0 + .95, t0 + 1.5, MOTION.pop);
  const cs = (x, y) => `translate(${x} ${y}) scale(${cut}) translate(${-x} ${-y})`;
  return (
    <svg width={size} height={size} viewBox="0 0 1024 1024" style={{ overflow: 'visible', display: 'block' }}>
      <defs><radialGradient id="fg"><stop offset="0" stopColor={OR} stopOpacity=".6" /><stop offset="1" stopColor={OR} stopOpacity="0" /></radialGradient></defs>
      <circle cx="512" cy="540" r="760" fill="url(#fg)" opacity={tileO} />
      <g opacity={tileO} transform={`translate(512 512) scale(${tileS}) rotate(${(1 - tileS) * -30}) translate(-512 -512)`}>
        <rect x="4" y="4" width="1016" height="1016" rx="210" fill="#0B0B0B" stroke="#262626" strokeWidth="6" />
        <g transform={`translate(512 470) scale(${headS}) translate(-512 -470)`}><polygon points={HEAD} fill={OR} />{CUTS.map(([p, x, y], i) => <polygon key={i} points={p} fill="#0B0B0B" transform={cs(x, y)} />)}</g>
        <polygon points={CHEV} fill={OR} transform={`translate(0 ${chev})`} opacity={cl(1 - chev / 120)} />
      </g>
    </svg>
  );
}

// ---------- hands ----------
const HAND = [[0, 0], [-.35, -.25], [-.6, -.5], [-.78, -.75], [-.92, -.98], [-.28, -1], [-.32, -1.45], [-.34, -1.72], [-.36, -1.98], [0, -1.05], [0, -1.55], [0, -1.85], [0, -2.12], [.26, -.98], [.3, -1.42], [.32, -1.7], [.34, -1.94], [.5, -.85], [.6, -1.2], [.66, -1.42], [.7, -1.62]];
const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20]];
const TIP = [4, 8, 12, 16, 20];
function handPts(wx, wy, s, mirror, curls, tilt, spread = 0) {
  const out = HAND.map((p, i) => [i ? p[0] * (1 + spread) : p[0], p[1]]);
  for (let f = 0; f < 5; f++) { const b = 1 + f * 4, c = curls[f] || 0, base = f === 0 ? out[1] : out[b]; for (let k = f === 0 ? 2 : 1; k < 4; k++) { const p = out[b + k]; p[0] = base[0] + (p[0] - base[0]) * (1 - .72 * c); p[1] = base[1] + (p[1] - base[1]) * (1 - .78 * c) + .32 * c * k; } }
  const ct = Math.cos(tilt), st = Math.sin(tilt);
  return out.map(([x, y]) => { if (mirror) x = -x; return [wx + (x * ct - y * st) * s, wy + (x * st + y * ct) * s]; });
}
function WireHand({ pts, col = INK, tipCol = OR }) {
  const palm = [0, 1, 2, 5, 9, 13, 17].map(i => pts[i].join(',')).join(' ');
  const W = (a, b) => (a === 0 || b === 0 ? 30 : a < 5 && b < 5 ? 24 : TIP.includes(b) ? 19 : 23);
  return (<g>
    <polygon points={palm} fill="rgba(246,239,230,.12)" stroke="rgba(246,239,230,.3)" strokeWidth="3" strokeLinejoin="round" />
    {BONES.map(([a, b], i) => <line key={'v' + i} x1={pts[a][0]} y1={pts[a][1]} x2={pts[b][0]} y2={pts[b][1]} stroke={col} strokeOpacity=".14" strokeWidth={W(a, b)} strokeLinecap="round" />)}
    {BONES.map(([a, b], i) => <line key={i} x1={pts[a][0]} y1={pts[a][1]} x2={pts[b][0]} y2={pts[b][1]} stroke={col} strokeOpacity=".85" strokeWidth="3.5" strokeLinecap="round" />)}
    {pts.map((p, i) => TIP.includes(i) ? <g key={'j' + i}><circle cx={p[0]} cy={p[1]} r="17" fill={tipCol} opacity=".25" /><circle cx={p[0]} cy={p[1]} r="10" fill={tipCol} /></g> : <circle key={'j' + i} cx={p[0]} cy={p[1]} r="5" fill={col} />)}
  </g>);
}
const CPOSE = [[-.3, .7], [.05, .82], [.34, .95], [.62, .94], [.86, .8], [.12, -.8], [.52, -.92], [.83, -.84], [1.04, -.64], [.04, -.5], [.48, -.56], [.8, -.46], [1.04, -.3], [0, -.2], [.43, -.21], [.73, -.13], [.96, 0], [.0, .1], [.37, .13], [.6, .2], [.8, .3]];
function handC(wx, wy, s, mirror, curls) {
  const out = CPOSE.map(p => [p[0], p[1]]);
  for (let f = 0; f < 5; f++) { const b = 1 + f * 4, c = curls[f] || 0, base = f === 0 ? out[2] : out[b]; for (let k = f === 0 ? 1 : 1; k < 4; k++) { if (f === 0 && k === 1) continue; const p = out[b + k]; p[0] = base[0] + (p[0] - base[0]) * (1 - .62 * c); p[1] = lerp(p[1], base[1] * .6, .55 * c); } }
  return out.map(([x, y]) => [wx + (mirror ? x : -x) * s, wy + y * s]);
}
const rot = (a, [x, y]) => [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
function framePose(t, w, h) {
  const th = .09 * Math.sin(t * 1.3), cx = 960 + Math.sin(t * .9) * 24, cy = 560 + Math.cos(t * .7) * 10, s = 150;
  const cn = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(p => { const r = rot(th, p); return [cx + r[0], cy + r[1]]; });
  const crook = [.45 * s, -.75 * s], lo = rot(th, crook), ro = rot(th + Math.PI, crook);
  const fc = [0, 0, 1, 1, 1];
  return { corners: cn, th, L: handPts(cn[3][0] - lo[0], cn[3][1] - lo[1], s, true, fc, th), R: handPts(cn[1][0] - ro[0], cn[1][1] - ro[1], s, true, fc, th + Math.PI) };
}

// keyboard: left pinky (lowest) → left thumb → right thumb → right pinky (highest)
const NOTE10 = ['C#2', 'E2', 'F#2', 'G#2', 'B2', 'C#3', 'E3', 'F#3', 'G#3', 'B3'];
const keyOf = (side, f) => side === 0 ? 4 - f : 5 + f;
const fingerOf = k => k < 5 ? [0, 4 - k] : [1, k - 5];

function useScript() {
  const { CUES: C } = useComposition();
  const MEL = [[0, 3], [1, 6], [0, 4], [1, 7], [0, 2], [1, 8], [0, 4], [1, 6], [0, 3], [1, 9]].map(([h, k], i) => ({ h, k, f: (i * 3 + 1) % 5, t: C.Fold + 1.0 + i * .55 }));
  const HOLD = { h: 1, k: 7, f: 2, t: C.Hold + .9, end: C.Hold + 4.1 };
  return { C, MEL, HOLD, events: [...MEL, { h: HOLD.h, k: HOLD.k, t: HOLD.t }] };
}

function handsAt(t, C, MEL, HOLD) {
  const rise = anim(t, 700, 0, C.Raise + .3, C.Raise + 1.5), rise2 = anim(t, 700, 0, C.Raise + .45, C.Raise + 1.65);
  const pin = anim(t, 0, 1, C.PointIn + .5, C.PointIn + 1.9, MOTION.draw);
  const out = anim(t, 0, 1, C.Remix + .1, C.Remix + .9, MOTION.draw) - anim(t, 0, 1, C.Glass, C.Glass + .7, MOTION.draw);
  const wig = cl((t - C.Raise - 1.6) / .3) * (1 - cl((t - C.Raise - 3.6) / .3));
  const curls = [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0]];
  for (let s = 0; s < 2; s++) for (let f = 0; f < 5; f++) curls[s][f] = wig * Math.max(0, Math.sin((t - C.Raise - 1.6) * 7 - f * .8 - s * .5)) * .8;
  for (const e of MEL) { const d = t - e.t; if (d > -.14 && d < .4) { const s = e.h, f = e.f; curls[s][f] = Math.max(curls[s][f], d < 0 ? 1 + d / .14 : 1 - d / .4); } }
  if (t > HOLD.t - .14 && t < HOLD.end + .4) { const s = HOLD.h, f = HOLD.f; curls[s][f] = Math.min(cl((t - HOLD.t + .14) / .14), cl((HOLD.end + .4 - t) / .4)); }
  const MOV = [{ h: 0, k: 2, t: C.Keys + 1 }, { h: 1, k: 7, t: C.Keys + 1.7 }, { h: 0, k: 6, t: C.Keys + 2.5 }, { h: 1, k: 9, t: C.Keys + 3.3 }, { h: 0, k: 1, t: C.Keys + 4.1 }, { h: 1, k: 5, t: C.Keys + 4.8 }, ...MEL, HOLD];
  const hy = side => { let y = 0; for (const e of MOV) if (e.h === side) { const k = cl((t - e.t + .35) / .3); if (k <= 0) break; y = lerp(y, (4.5 - e.k) * 34, MOTION.draw(k)); } return y * (1 - cl((t - C.Shapes) / .6)); };
  const sh = C.Shapes, beats = [[sh + .4, sh + 2.6, 'fist'], [sh + 2.6, sh + 4.9, 'pinch'], [sh + 4.9, sh + 7.2, 'frame']];
  let shapeK = 0;
  beats.forEach(([a, b, kind]) => {
    const k = cl((t - a) / .35) * cl((b - .2 - t) / .3); if (k <= 0) return; shapeK = Math.max(shapeK, k);
    const c = kind === 'fist' ? [1, 1, 1, 1, 1] : kind === 'pinch' ? [.75, .75, 0, 0, 0] : [0, 0, 1, 1, 1];
    for (let s = 0; s < 2; s++) for (let f = 0; f < 5; f++) curls[s][f] = Math.max(curls[s][f], c[f] * k);
  });
  for (let s = 0; s < 2; s++) for (let f = 0; f < 5; f++) curls[s][f] = Math.max(curls[s][f], 0 * pin);
  const bob = Math.sin(t * 1.2) * 8;
  const lw = [lerp(640, 330, pin), lerp(1000, 630, pin) + rise + bob - hy(0)], rw = [lerp(1280, 1590, pin), lerp(1000, 630, pin) + rise2 - bob - hy(1)];
  const tilt = pin * Math.PI / 2;
  const blendP = (A0, B0, k) => A0.map((p, i) => [lerp(p[0], B0[i][0], k), lerp(p[1], B0[i][1], k)]);
  const upL = handPts(lerp(640, 330, pin), lw[1] + out * 700, 150, true, curls[0], 0), upR = handPts(lerp(1280, 1590, pin), rw[1] + out * 700, 150, false, curls[1], 0);
  const cL = handC(lw[0], lw[1] + out * 700 - 40, 160, true, curls[0]), cR = handC(rw[0], rw[1] + out * 700 - 40, 160, false, curls[1]);
  let L = blendP(upL, cL, MOTION.draw(pin)), R = blendP(upR, cR, MOTION.draw(pin));
  const frames = [[C.Shapes + 4.9, C.Shapes + 7.1, 640, 390, 'freeze'], [C.Glass + .5, C.Glass + 4.7, 760, 440, 'glass']];
  let fk = 0, FP = null, kind = null;
  frames.forEach(([a, b, w, h, kd]) => { const k = cl((t - a) / .45) * cl((b - t) / .4); if (t > a - .1 && t < b + 1.4) { const P = framePose(t, w, h); if (!FP || k > fk) { FP = P; kind = kd; } fk = Math.max(fk, k); } });
  if (FP && fk > 0) { const e = MOTION.draw(fk); L = L.map((p, i) => [lerp(p[0], FP.L[i][0], e), lerp(p[1], FP.L[i][1], e)]); R = R.map((p, i) => [lerp(p[0], FP.R[i][0], e), lerp(p[1], FP.R[i][1], e)]); }
  return { L, R, pin, out, shapeK, fk, FP, kind };
}

// ---------- kinetic type ----------
function Kinetic({ text, at, until, size = 112, y = 70, color = INK, weight = 700, num }) {
  const { T } = useComposition();
  if (T < at - .05 || T > until + .05) return null;
  const words = text.split(' ');
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top: y, display: 'flex', justifyContent: 'center', alignItems: 'baseline', gap: size * .26, flexWrap: 'wrap', padding: '0 120px' }}>
      {num && <span style={{ font: `600 30px ${MONO}`, color: OR, opacity: cl((T - at) / .3) * cl((until - T) / .3), alignSelf: 'center', marginRight: 10 }}>{num}</span>}
      {words.map((w, i) => {
        const inK = MOTION.enter(cl((T - at - i * .07) / .45)), outK = MOTION.draw(cl((T - (until - .45) - i * .04) / .4));
        return <span key={i} style={{ display: 'inline-block', overflow: 'hidden', paddingBottom: size * .12, lineHeight: 1 }}><span style={{ display: 'inline-block', font: `${weight} ${size}px ${FONT}`, letterSpacing: '-.045em', color, transform: `translateY(${(1 - inK) * 110 - outK * 110}%)` }}>{w}</span></span>;
      })}
    </div>
  );
}

function Wipes() {
  const { T, CUES: C } = useComposition();
  const bs = [C.Raise, C.PointIn, C.Keys, C.Fold, C.Hold, C.Shapes, C.Remix, C.Glass, C.Outro];
  return (<React.Fragment>{bs.map((b, i) => {
    const k = cl((T - b + .4) / .8); if (k <= 0 || k >= 1) return null;
    const x = lerp(-1400, 2400, MOTION.draw(k));
    return <div key={i} style={{ position: 'absolute', top: -100, bottom: -100, left: x - 500, width: 1000, background: i % 2 ? '#E8401F' : OR, transform: 'skewX(-14deg)' }}></div>;
  })}</React.Fragment>);
}

const SHARDS = (() => { const out = []; for (let gx = 0; gx < 5; gx++) for (let gy = 0; gy < 3; gy++) { const j = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([a, b]) => [(gx + a) / 5 + (a && gx < 4 ? (Math.sin(gx * 7 + gy) * .04) : 0), (gy + b) / 3 + (b && gy < 2 ? Math.cos(gx * 3 + gy * 5) * .05 : 0)]); out.push([j[0], j[1], j[2]], [j[0], j[2], j[3]]); } return out; })();
const FACETS = Array.from({ length: 34 }, (_, i) => { const u = Math.abs(Math.sin(i * 91.7)) % 1, v = Math.abs(Math.sin(i * 47.3 + 2)) % 1, s = .06 + (Math.abs(Math.sin(i * 13.1)) % 1) * .12; return [[u, v], [u + s, v + s * .4], [u + s * .3, v + s * 1.1]]; });
function Pane({ P, edge, bloom, gone, kind, name, flash, T }) {
  if (!P || edge <= 0) return null;
  const c = P.corners, at = ([u, v]) => { const x0 = lerp(c[0][0], c[1][0], u), y0 = lerp(c[0][1], c[1][1], u), x1 = lerp(c[3][0], c[2][0], u), y1 = lerp(c[3][1], c[2][1], u); return [lerp(x0, x1, v), lerp(y0, y1, v)]; };
  const poly = c.map(p => p.join(',')).join(' '), cx = (c[0][0] + c[2][0]) / 2, cy = (c[0][1] + c[2][1]) / 2, R = Math.hypot(c[2][0] - c[0][0], c[2][1] - c[0][1]) / 2;
  const id = 'pane-' + kind, ice = kind === 'freeze', deg = P.th * 180 / Math.PI;
  const shard = kind === 'glass' && gone > 0;
  return (<g>
    <defs>
      <clipPath id={id + 'c'}><polygon points={poly} /></clipPath>
      <radialGradient id={id + 'g'} cx={cx} cy={cy} r={R} gradientUnits="userSpaceOnUse">
        {ice ? [<stop key="a" offset="0" stopColor="#EAF6FF" stopOpacity=".55" />, <stop key="b" offset=".7" stopColor="#9FD4FF" stopOpacity=".35" />, <stop key="c" offset="1" stopColor="#5AA8E8" stopOpacity=".5" />]
          : [<stop key="a" offset="0" stopColor="#FFF27A" />, <stop key="b" offset=".25" stopColor="#FF5A1F" />, <stop key="c" offset=".55" stopColor="#C2187A" />, <stop key="d" offset=".8" stopColor="#3B1C9E" />, <stop key="e" offset="1" stopColor="#0A1A5A" />]}
      </radialGradient>
    </defs>
    {!shard && <g clipPath={`url(#${id}c)`} opacity={ice ? 1 - gone : 1}>
      <circle cx={cx} cy={cy} r={R * 1.1 * MOTION.enter(bloom)} fill={`url(#${id}g)`} />
      {!ice && bloom > 0 && [0, 1, 2].map(i => <ellipse key={i} cx={cx + Math.sin(T * .8 + i * 2) * R * .35} cy={cy + Math.cos(T * .6 + i) * R * .2} rx={R * .5} ry={R * .35} fill={['#FFE14A', '#FF2E6A', '#6A3BFF'][i]} opacity={.35 * bloom} />)}
      {!ice && bloom > 0 && Array.from({ length: 24 }, (_, i) => <rect key={'s' + i} x={c[0][0] - 200} y={cy - R + i * (R * 2 / 24)} width={R * 4} height="2" fill="#000" opacity={.12 * bloom} />)}
      {ice && FACETS.map((tri, i) => { const pts = tri.map(at), dy = gone * (80 + (i % 5) * 30); return <polygon key={i} points={pts.map(p => `${p[0]},${p[1] + dy}`).join(' ')} fill="#FFFFFF" fillOpacity={.12 * bloom} stroke="#FFFFFF" strokeOpacity={.45 * bloom} strokeWidth="1.5" />; })}
      {ice && bloom > 0 && Array.from({ length: 18 }, (_, i) => { const p = at([(i * .37) % 1, (i * .61) % 1]); return <circle key={'k' + i} cx={p[0]} cy={p[1] + gone * 140} r={2 + (i % 3)} fill="#fff" opacity={bloom * (.4 + .6 * Math.abs(Math.sin(T * 3 + i)))} />; })}
    </g>}
    {shard && SHARDS.map((tri, i) => {
      const pts = tri.map(at), mx = (pts[0][0] + pts[1][0] + pts[2][0]) / 3, my = (pts[0][1] + pts[1][1] + pts[2][1]) / 3, dx = mx - cx, dy = my - cy, d = Math.hypot(dx, dy) || 1, g = MOTION.enter(gone);
      const tx = dx / d * g * (260 + (i % 4) * 80), ty = dy / d * g * 220 + gone * gone * 420, r = (i % 2 ? 1 : -1) * g * (40 + i * 7);
      return <g key={i} transform={`translate(${tx} ${ty}) rotate(${r} ${mx} ${my})`} opacity={1 - gone}>
        <clipPath id={id + 's' + i}><polygon points={pts.map(p => p.join(',')).join(' ')} /></clipPath>
        <g clipPath={`url(#${id}s${i})`}><circle cx={cx} cy={cy} r={R * 1.1} fill={`url(#${id}g)`} /></g>
        <polygon points={pts.map(p => p.join(',')).join(' ')} fill="#fff" fillOpacity=".08" stroke="#fff" strokeOpacity=".8" strokeWidth="2" />
      </g>;
    })}
    {!shard && <g opacity={ice ? 1 - gone : 1}>
      <polygon points={poly} fill="none" stroke={ice ? ICE : OR} strokeWidth={22 + flash * 30} strokeLinejoin="round" opacity={.22 + flash * .5} pathLength="1" strokeDasharray="1" strokeDashoffset={1 - MOTION.draw(edge)} />
      <polygon points={poly} fill="none" stroke="#FFFFFF" strokeWidth={4 + flash * 4} strokeLinejoin="round" pathLength="1" strokeDasharray="1" strokeDashoffset={1 - MOTION.draw(edge)} />
      <g transform={`translate(${c[0][0]} ${c[0][1]}) rotate(${deg}) translate(30 0) scale(${MOTION.pop(cl(bloom * 1.4))})`}>
        <rect x="0" y="-26" width={name.length * 24 + 40} height="52" rx="26" fill={ice ? ICE : OR} />
        <text x={(name.length * 24 + 40) / 2} y="12" textAnchor="middle" fontSize="34" fontWeight="800" letterSpacing="2" fill="#1C1611" fontFamily={FONT}>{name}</text>
      </g>
    </g>}
  </g>);
}

// ---------- the piece ----------
function Piece() {
  const { T } = useComposition();
  const { C, MEL, HOLD, events } = useScript();
  const A = useA();
  const H = handsAt(T, C, MEL, HOLD);
  const camO = A(0, .55, C.PointIn + 2.4, C.PointIn + 3.8) * (1 - A(0, 1, C.Remix, C.Remix + .8));
  const strO = A(0, 1, C.PointIn + 2.0, C.PointIn + 3.0, MOTION.draw) * (1 - A(0, 1, C.Remix + .1, C.Remix + .9, MOTION.draw));
  const labK = i => A(0, 1, C.Keys + .7 + i * .2, C.Keys + 1.05 + i * .2, MOTION.pop);
  const stripO = A(0, 1, C.Keys + .3, C.Keys + .8) * (1 - A(0, 1, C.Shapes, C.Shapes + .5));
  const sweep = k => 0;
  const lastHit = k => { let best = -1; for (const e of events) if (e.k === k && e.t <= T) best = e.t; return best; };
  const MOVS = [{ h: 0, k: 2, t: C.Keys + 1 }, { h: 1, k: 7, t: C.Keys + 1.7 }, { h: 0, k: 6, t: C.Keys + 2.5 }, { h: 1, k: 9, t: C.Keys + 3.3 }, { h: 0, k: 1, t: C.Keys + 4.1 }, { h: 1, k: 5, t: C.Keys + 4.8 }, ...events];
  const keyLit = k => { const h = lastHit(k), held = k === HOLD.k && T >= HOLD.t && T < HOLD.end ? 1 : 0; return Math.max(held, h > 0 ? Math.exp(-(T - h) * 2.4) : 0, sweep(k)); };
  const played = events.filter(e => e.t <= T && T < C.Shapes);
  const cur = played[played.length - 1], curAge = cur ? T - cur.t : 99;
  const held = T >= HOLD.t && T < HOLD.end, holdP = cl((T - HOLD.t) / (HOLD.end - HOLD.t));
  const bigNoteO = cur ? (held && cur.k === HOLD.k ? 1 : Math.exp(-curAge * 1.4)) : 0;
  const drive = A(0, 1, C.Shapes + .4, C.Shapes + .7) - A(0, 1, C.Shapes + 2.4, C.Shapes + 2.7);
  const wob = A(0, 1, C.Shapes + 2.6, C.Shapes + 2.9) - A(0, 1, C.Shapes + 4.7, C.Shapes + 5.0);
  const frz = 0;
  const strCol = frz > .5 ? ICE : '#FFF1DE', glow = frz > .5 ? '#7CC0FF' : '#FF7A1F';
  const fz0 = C.Shapes + 4.85, hold = cl((T - fz0) / .2) * (1 - cl((T - C.Shapes - 6.8) / .5));
  const H0 = hold > 0 ? handsAt(fz0, C, MEL, HOLD) : H;
  const tipsL = TIP.map(i => [lerp(H.L[i][0], H0.L[i][0], hold), lerp(H.L[i][1], H0.L[i][1], hold)]), tipsR = TIP.map(i => [lerp(H.R[i][0], H0.R[i][0], hold), lerp(H.R[i][1], H0.R[i][1], hold)]);
  const S = C.Shapes, G = C.Glass;
  const fzP = T > S + 4.8 && T < S + 7.6 ? framePose(T, 640, 390) : null, glP = T > G + .5 && T < G + 6 ? framePose(T, 760, 440) : null;
  const glFlash = T > G + 1.2 ? Math.exp(-(T - G - 1.2) * 4) + (T > G + 1.2 ? .4 * Math.exp(-((T * 140 / 60) % 1) * 6) * cl((T - G - 1.4) * 2) * (1 - cl((T - G - 4.6) * 3)) : 0) : 0;
  const tipOf = k => { const [s, f] = fingerOf(k); return s ? tipsR[f] : tipsL[f]; };
  const flashF = f => Math.max(keyLit(keyOf(0, f)), keyLit(keyOf(1, f)));
  // remix waveform
  const waveO = A(0, 1, C.Remix + .6, C.Remix + 1.6) * (1 - A(0, 1, C.Outro - .3, C.Outro + .3));
  const tear = A(0, 1, C.Remix + 2.8, C.Remix + 3.1) - A(0, 1, C.Glass - .4, C.Glass);
  const wy = 600, wa = 150, ph = 700, xs = []; for (let x = -20; x <= 1940; x += 14) xs.push(x);
  const amps = xs.map((x, j) => { const u = x / 14 + T * 22; let a = .38 + .3 * Math.abs(Math.sin(u * .23)) + .18 * Math.abs(Math.sin(u * 1.3 + 1)) + .14 * Math.exp(-((u % 4 + 4) % 4) * 1.4); if (x > ph - 40) a *= 1 + tear * (j % 2 ? .55 : .1) * Math.exp(-(x - ph) / 500); return a * (.9 + .1 * Math.sin(x * .02 - T * 3)); });
  const wpath = sc => { let d = `M${xs[0]} ${wy - amps[0] * wa * sc}`; for (let j = 1; j < xs.length; j++) d += ` L${xs[j]} ${wy - amps[j] * wa * sc}`; for (let j = xs.length - 1; j >= 0; j--) d += ` L${xs[j]} ${wy + amps[j] * wa * sc}`; return d + ' Z'; };
  const beat = Math.floor(T * 140 / 60) % 4;
  const welcomeO = 1 - A(0, 1, C.Raise - .4, C.Raise + .1), outO = A(0, 1, C.Outro + .3, C.Outro + .8);
  const shapeWord = [[C.Shapes + .4, C.Shapes + 2.5, 'DRIVE', 'Fist'], [C.Shapes + 2.6, C.Shapes + 4.8, 'WOBBLE', 'Pinch'], [C.Shapes + 4.9, C.Shapes + 7.1, 'FREEZE', 'Frame']];
  return (
    <div data-screen-label={`Onboarding ${Math.floor(T)}s`} style={{ position: 'absolute', inset: 0, background: BG, overflow: 'hidden', fontFamily: FONT }}>
      <div style={{ position: 'absolute', left: 560 + Math.sin(T * .3) * 260, top: 80, width: 1200, height: 1200, borderRadius: '50%', background: 'radial-gradient(closest-side, rgba(255,77,46,.26), rgba(255,77,46,0))' }}></div>
      <div style={{ position: 'absolute', inset: 0, opacity: camO, background: 'radial-gradient(30% 50% at 50% 62%, #9A7F6B 0%, #705848 50%, rgba(0,0,0,0) 80%), linear-gradient(180deg, #6E5C50, #3D312A 60%, #271F1B)' }}></div>
      <div style={{ position: 'absolute', inset: 0, opacity: camO * 1.6, background: 'linear-gradient(180deg, rgba(11,8,6,.85) 0%, rgba(11,8,6,0) 30%, rgba(11,8,6,0) 70%, rgba(11,8,6,.85) 100%)' }}></div>
      {/* giant shape words behind hands */}
      {shapeWord.map(([a, b, w, s], i) => { const k = cl((T - a) / .3) * cl((b - T) / .3); if (k <= 0 || i === 2) return null; const sc = .85 + .15 * MOTION.pop(cl((T - a) / .5));
        return <div key={w} style={{ position: 'absolute', left: 0, right: 0, top: 360, textAlign: 'center', opacity: k, transform: `scale(${sc})` }}>
          <div style={{ font: `800 300px ${FONT}`, letterSpacing: '-.06em', lineHeight: .9, color: i === 2 ? ICE : OR, transform: i === 0 ? `translate(${Math.sin(T * 80) * 6 * drive}px, ${Math.cos(T * 67) * 5 * drive}px)` : i === 1 ? `skewX(${Math.sin(T * 9) * 12 * wob}deg)` : 'none', opacity: .92 }}>{w}</div>
        </div>; })}
      <svg width="1920" height="1080" style={{ position: 'absolute', inset: 0, overflow: 'visible' }}>
        <defs><linearGradient id="wg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#FFF6EC" stopOpacity=".36" /><stop offset=".5" stopColor="#FFD6B4" stopOpacity=".14" /><stop offset="1" stopColor="#FFBE96" stopOpacity=".28" /></linearGradient><clipPath id="wc"><path d={wpath(1)} /></clipPath></defs>
        {/* strings */}
        <g opacity={strO}>
          {[0, 1, 2, 3, 4].map(f => {
            const [lx, ly] = tipsL[f], [rx, ry] = tipsR[f], fl = flashF(f), b = fl * 26 * Math.cos(T * 26), wy2 = wob * 50 * Math.sin(T * 8 + f), jit = drive * 8 * Math.sin(T * 90 + f * 7);
            const d = `M${lx} ${ly} Q${(lx + rx) / 2} ${(ly + ry) / 2 + b + wy2 + jit} ${rx} ${ry}`;
            return <g key={f}><path d={d} fill="none" stroke={glow} strokeWidth="26" strokeLinecap="round" opacity={.14 + fl * .45} pathLength="1" strokeDasharray="1" strokeDashoffset={1 - strO} /><path d={d} fill="none" stroke={strCol} strokeWidth={4 + fl * 4} strokeLinecap="round" pathLength="1" strokeDasharray="1" strokeDashoffset={1 - strO} /></g>;
          })}
        </g>
        <g transform={`translate(0 ${H.out * 0})`} opacity={A(0, 1, C.Raise + .3, C.Raise + .8)}><WireHand pts={H.L} tipCol={frz > .5 ? ICE : OR} /><WireHand pts={H.R} tipCol={frz > .5 ? ICE : OR} /></g>
        {(H.fk > 0 || (T > G + .4 && T < G + 6)) && <g><WireHand pts={H.L} tipCol={T < G ? ICE : OR} /><WireHand pts={H.R} tipCol={T < G ? ICE : OR} /></g>}
        {/* glass note pops at the plucking fingertip */}
        {events.filter(e => T >= e.t && T < e.t + 1.6 && T < C.Shapes).map(e => {
          const age = T - e.t, tip = (e.h ? H.R : H.L)[TIP[e.f ?? 1]], inK = MOTION.enter(cl(age / .35)), out = cl((age - 1.1) / .5);
          const x = tip[0], y = tip[1] - 46 - inK * 10 - out * 18, w = 150;
          return <g key={'np' + e.t} transform={`translate(${x} ${y}) scale(${.9 + .1 * inK})`} opacity={inK * (1 - out)}>
            <rect x={-w / 2} y="-34" width={w} height="68" rx="34" fill="rgba(28,22,18,.55)" stroke="rgba(255,255,255,.28)" strokeWidth="1.5" />
            <rect x={-w / 2 + 6} y="-30" width={w - 12} height="24" rx="12" fill="rgba(255,255,255,.08)" />
            <circle cx={-w / 2 + 30} cy="0" r="8" fill="#FF9C5C" /><circle cx={-w / 2 + 30} cy="0" r="16" fill="#FF9C5C" opacity=".25" />
            <text x="16" y="13" textAnchor="middle" fontSize="38" fontWeight="700" fill={INK} fontFamily={FONT}>{NOTE10[e.k]}</text>
          </g>; })}
        <Pane P={fzP} kind="glass" name={T < S + 6.0 ? 'ECHO TRAIL' : 'PRISM'} T={T} edge={A(0, 1, S + 5.0, S + 5.5)} bloom={A(0, 1, S + 5.4, S + 6.0)} gone={A(0, 1, S + 6.8, S + 7.6)} flash={(T > S + 5.4 ? Math.exp(-(T - S - 5.4) * 3) * .6 : 0) + (T > S + 6.0 ? Math.exp(-(T - S - 6.0) * 4) : 0)} />
        {/* glass waveform */}
        <g opacity={waveO}>
          <path d={wpath(1)} fill="url(#wg)" />
          <g clipPath="url(#wc)"><rect x="-20" y="300" width={ph + 20} height="600" fill="#FF8030" opacity=".3" /><path d={wpath(.55)} fill="rgba(242,112,31,.38)" /><path d={wpath(.28)} fill="rgba(200,60,20,.45)" /><rect x={((T * 260) % 2400) - 300} y="300" width="320" height="600" fill="#fff" opacity=".12" /></g>
          <rect x={ph - 2} y={wy - 230} width="4" height="460" fill="#fff" /><circle cx={ph} cy={wy - 230} r="9" fill="#fff" />
        </g>
        <Pane P={glP} kind="glass" name="THERMAL" T={T} edge={A(0, 1, G + .7, G + 1.2)} bloom={A(0, 1, G + 1.1, G + 1.9)} gone={A(0, 1, G + 4.7, G + 5.7)} flash={glFlash} />
      </svg>
      {/* hold ring + big note */}
      {bigNoteO > .01 && <div style={{ position: 'absolute', left: 0, right: 0, top: 300, display: 'flex', justifyContent: 'center', opacity: bigNoteO }}>
        <div style={{ position: 'relative', width: 260, height: 260, display: 'grid', placeItems: 'center', transform: `scale(${1 + Math.exp(-curAge * 6) * .12})` }}>
          {held && <svg width="260" height="260" style={{ position: 'absolute', inset: 0, transform: 'rotate(-90deg)' }}><circle cx="130" cy="130" r="120" fill="none" stroke="rgba(255,255,255,.14)" strokeWidth="10" /><circle cx="130" cy="130" r="120" fill="none" stroke={OR} strokeWidth="10" strokeLinecap="round" pathLength="1" strokeDasharray="1" strokeDashoffset={1 - holdP} /></svg>}
          <span style={{ font: `800 124px ${FONT}`, letterSpacing: '-.05em', color: INK, textShadow: '0 4px 40px rgba(0,0,0,.6)' }}>{cur ? NOTE10[cur.k] : ''}</span>
        </div>
      </div>}
      {/* remix chips */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 880, display: 'flex', justifyContent: 'center', gap: 16, opacity: tear }}>
        <div style={{ padding: '18px 34px', borderRadius: 26, background: OR, color: '#1C1611', font: `800 52px ${FONT}`, letterSpacing: '-.02em', transform: `scale(${.8 + .2 * MOTION.pop(cl((T - C.Remix - 2.8) / .4))})` }}>FIST → TEAROUT</div>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', padding: '0 26px', borderRadius: 26, background: 'rgba(255,255,255,.08)' }}>{[0, 1, 2, 3].map(i => <span key={i} style={{ width: 22, height: 22, borderRadius: 11, background: beat === i ? OR : 'rgba(255,255,255,.25)' }}></span>)}</div>
      </div>
      {/* titles */}
      <Kinetic num="01" text="Raise your hands" at={C.Raise + .2} until={C.PointIn} />
      <Kinetic num="02" text="Curve your hands into a C" at={C.PointIn + .1} until={C.Keys} />
      <Kinetic text="Facing each other, like holding a ball." at={C.PointIn + .9} until={C.Keys} y={196} size={44} weight={500} color={SUB} />
      <Kinetic num="03" text="Hand height picks the note" at={C.Keys + .1} until={C.Fold} size={100} />
      <Kinetic text="Raise a hand for higher notes, lower it for lower." at={C.Keys + 1.0} until={C.Fold} y={196} size={44} weight={500} color={SUB} />
      <Kinetic num="04" text="Curl any finger to pluck" at={C.Fold + .1} until={C.Hold} />
      <Kinetic text="Two hands play two notes." at={C.Fold + .9} until={C.Hold} y={196} size={40} weight={500} color={SUB} />
      <Kinetic num="05" text="Hold to sustain" at={C.Hold + .1} until={C.Shapes} />
      <Kinetic text="Works on REESE, LEAD and KEYS" at={C.Hold + 1.4} until={C.Shapes} y={196} size={44} weight={500} color={SUB} />
      <Kinetic num="06" text="Make a shape to change it" at={C.Shapes + .1} until={C.Remix} />
      {shapeWord.map(([a, b, w, s]) => <Kinetic key={s} text={s} at={a} until={b} y={720} size={64} weight={600} color={INK} />)}
      <Kinetic num="07" text="Switch to REMIX" at={C.Remix + .1} until={C.Glass} />
      <Kinetic text="Press M. Then hold a shape on the beat." at={C.Remix + 1.0} until={C.Glass} y={196} size={44} weight={500} color={SUB} />
      <Kinetic num="08" text="Frame a window" at={C.Glass + .1} until={C.Outro} />
      <Kinetic text="Each frame opens a world. Let go and it shatters." at={C.Glass + .6} until={C.Outro} y={196} size={44} weight={500} color={SUB} />
      <Kinetic text="♪ Locks on the beat" at={C.Glass + 1.2} until={C.Glass + 4.5} y={930} size={48} weight={600} color={OR} />
      <Kinetic text="♪ Shatter" at={C.Glass + 4.7} until={C.Outro} y={930} size={48} weight={600} color={INK} />
      <Kinetic text="Frame it: the last 4 beats loop" at={C.Shapes + 5.2} until={C.Shapes + 6.0} y={930} size={48} weight={600} color={OR} />
      <Kinetic text="Pinch to change the style" at={C.Shapes + 6.0} until={C.Shapes + 6.8} y={930} size={48} weight={600} color={INK} />
      <Kinetic text="♪ Let go: shatter" at={C.Shapes + 6.8} until={C.Remix} y={930} size={48} weight={600} color={INK} />
      {/* welcome / outro */}
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', opacity: welcomeO }}>
        <FoxMark size={340} t0={C.Welcome + .2} />
      </div>
      <Kinetic text="Welcome to FoxBox" at={C.Welcome + 1.7} until={C.Raise} y={800} size={120} />
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', opacity: outO, paddingBottom: 120 }}>
        <FoxMark size={260} t0={C.Outro + .3} />
      </div>
      <Kinetic text="Let’s play." at={C.Outro + 1.3} until={C.Outro + 99} y={720} size={150} />
      <Wipes />
    </div>
  );
}

function FoxOnboarding() {
  return (<CompositionStage width={1920} height={1080} bg={BG} scenes={window.OM_SCENES} playback={window.OM_PLAYBACK}><Piece /></CompositionStage>);
}
window.FoxOnboarding = FoxOnboarding;
