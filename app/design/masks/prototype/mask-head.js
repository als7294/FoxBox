// MASKS prototype renderer: a procedural head + mask built from a config. Stand-in for the real three.js MaskPreview.
// <mask-head cfg='{json}' mode="turntable|live|clip|noface|heads" beat="1" reduced="1" still="1">  + window.MaskKit.thumb(cfg, opt) → dataURL
const URL3 = 'https://unpkg.com/three@0.160.0/build/three.module.js';
let T = null;
const ready = import(URL3).then((m) => { T = m; return m; });
const PI = Math.PI;
const g = (x, s) => Math.exp(-(x * x) / (2 * s * s));
const cl = (v, a, b) => Math.max(a, Math.min(b, v));
const n01 = (v, d = 50) => (v == null ? d : v) / 100;
const HEAD = { rx: 0.78, ry: 1, rz: 0.86 };
const BASES = {
  full: { span: 1.18, t0: 0.1, t1: 0.84, k: 1.05 },
  visor: { span: 1.18, t0: 0.1, t1: 0.84, k: 1.05 },
  hood: { span: 1.0, t0: 0.16, t1: 0.84, k: 1.05 },
  helmet: { span: 2, t0: 0, t1: 0.86, k: 1.13 },
  shards: { span: 1.18, t0: 0.1, t1: 0.84, k: 1.05 },
  monolith: { span: 1.18, t0: 0.1, t1: 0.84, k: 1.05 },
  voxels: { span: 1.18, t0: 0.1, t1: 0.84, k: 1.05 },
};
BASES.eq = BASES.halo = BASES.screen = BASES.slices = BASES.vu = BASES.vortex = BASES.shards;
const ABSTRACT = { shards: 1, monolith: 1, voxels: 1, eq: 1, halo: 1, screen: 1, slices: 1, vu: 1, vortex: 1 };
const reducedMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; }; }
function hash3(x, y, z) { const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453; return s - Math.floor(s); }
function shade(hex, amt) {
  const c = parseInt((hex || '#888888').slice(1), 16); let r = c >> 16, gg = (c >> 8) & 255, b = c & 255;
  const f = amt < 0 ? 0 : 255, p = Math.abs(amt);
  r = Math.round((f - r) * p + r); gg = Math.round((f - gg) * p + gg); b = Math.round((f - b) * p + b);
  return '#' + ((1 << 24) | (r << 16) | (gg << 8) | b).toString(16).slice(1);
}

// ---------------------------------------------------------------- geometry
function deform(ox, oy, oz, cfg, so, poly, jit) {
  let x = ox * HEAD.rx * so, y = oy * HEAD.ry * so, z = oz * HEAD.rz * so;
  const ny = oy, f = cl(oz, 0, 1);
  const br = n01(cfg.brow), ck = n01(cfg.cheeks), ch = n01(cfg.chin);
  z += br * 0.24 * f * g(ny - 0.36, 0.1);
  y += br * 0.02 * f * g(ny - 0.36, 0.09);
  x *= 1 + (ck - 0.5) * 0.34 * g(ny + 0.1, 0.2) * (0.4 + 0.6 * f);
  z += ck * 0.05 * f * g(ny + 0.05, 0.15);
  z += 0.12 * f * g(ny + 0.02, 0.12) * g(ox, 0.18);
  if (ny < -0.25) { const t = (-0.25 - ny) / 0.75; y -= ch * 0.34 * t * t; z += ch * 0.26 * t * f; x *= 1 - ch * 0.3 * t * f; }
  if (poly) { const j = (hash3(ox * 9, oy * 9, oz * 9) - 0.5) * (jit || 0.06); x += j; y += j * 0.6; z += j;
    const pop = 1 + hash3(ox * 5.3, oy * 4.1, oz * 6.7) * 0.09 * (0.3 + f); x *= pop; z *= pop; }
  return [x, y, z];
}
function sphereDeformed(cfg, so, poly, ws, hs, p0, pl, t0, tl, jit) {
  const geo = new T.SphereGeometry(1, ws, hs, p0, pl, t0, tl);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) { const v = deform(p.getX(i), p.getY(i), p.getZ(i), cfg, so, poly, jit); p.setXYZ(i, v[0], v[1], v[2]); }
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------- shell texture (primary, secondary, pattern, decal)
function drawTex(cfg, W, H) {
  const B = BASES[cfg.base] || BASES.full;
  const span = B.span * PI, t0 = B.t0 * PI, tl = (B.t1 - B.t0) * PI;
  const P = (d, t) => [(d / span + 0.5) * W, (t * PI - t0) / tl * H];
  const pxY = H / tl / HEAD.ry, pxX = W / span / HEAD.rx; // px per unit length
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const c = cv.getContext('2d');
  const ev = document.createElement('canvas'); ev.width = W; ev.height = H; const e = ev.getContext('2d');
  e.fillStyle = '#000'; e.fillRect(0, 0, W, H);
  let emi = false;
  const S = W / 1024;
  c.fillStyle = cfg.c1; c.fillRect(0, 0, W, H);
  // secondary: muzzle + jaw (fox-style two-tone)
  const half = [[0, 0.53], [0.18, 0.5], [0.3, 0.47], [0.48, 0.53], [0.8, 0.6], [1.15, 0.72], [1.3, 0.9], [0.8, 1.02]];
  c.fillStyle = cfg.c2; c.beginPath();
  half.forEach(([d, t], i) => { const q = P(d, t); i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1]); });
  for (let i = half.length - 1; i >= 0; i--) { const q = P(-half[i][0], half[i][1]); c.lineTo(q[0], q[1]); }
  c.closePath(); c.fill();
  // eye sockets
  const ex = 0.2 + n01(cfg.eyeGap) * 0.16, es = 0.6 + n01(cfg.eyeSize) * 0.9;
  c.save(); c.filter = `blur(${Math.round(10 * S)}px)`; c.fillStyle = shade(cfg.c1, -0.38); c.globalAlpha = 0.7;
  for (const sd of [-1, 1]) { const q = P(sd * Math.asin(cl(ex / HEAD.rx, -1, 1)), 0.46); c.beginPath(); c.ellipse(q[0], q[1], 0.15 * es * pxX, 0.1 * es * pxY, 0, 0, PI * 2); c.fill(); }
  c.restore();
  const a = n01(cfg.patAmt);
  const R = rng(1337);
  const both = (fn) => { fn(1); fn(-1); };
  const line = (ctx, pts, w, col) => { ctx.strokeStyle = col; ctx.lineWidth = w; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath(); pts.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1]))); ctx.stroke(); };
  switch (cfg.pattern) {
    case 'stripes': {
      c.fillStyle = '#0b0b0c'; c.globalAlpha = 0.25 + a * 0.7;
      for (let i = 0; i < 6; i++) {
        const t = 0.2 + i * 0.11 + R() * 0.03, reach = 0.42 + R() * 0.25, w = 0.022 + R() * 0.02;
        both((sd) => { const e0 = P(sd * 1.7, t - w), e1 = P(sd * 1.7, t + w), tip = P(sd * reach, t + 0.02); c.beginPath(); c.moveTo(e0[0], e0[1]); c.lineTo(tip[0], tip[1]); c.lineTo(e1[0], e1[1]); c.closePath(); c.fill(); });
      }
      c.globalAlpha = 1; break;
    }
    case 'circuit': {
      emi = true;
      for (let i = 0; i < 16; i++) {
        let d = 0.08 + R() * 1.1, t = 0.14 + R() * 0.66; const pts = [[d, t]];
        for (let k = 0; k < 3; k++) { if (k % 2) t += (R() - 0.5) * 0.16; else d += (R() - 0.3) * 0.3; pts.push([d, t]); }
        both((sd) => {
          const pp = pts.map(([dd, tt]) => P(sd * dd, tt));
          c.globalAlpha = 0.35 + a * 0.65; line(c, pp, 4 * S, cfg.c3); line(e, pp, 4 * S, '#fff');
          const end = pp[pp.length - 1]; c.fillStyle = cfg.c3; e.fillStyle = '#fff';
          c.beginPath(); c.arc(end[0], end[1], 7 * S, 0, PI * 2); c.fill(); e.beginPath(); e.arc(end[0], end[1], 7 * S, 0, PI * 2); e.fill();
        });
      }
      c.globalAlpha = 1; break;
    }
    case 'camo': {
      c.globalAlpha = 0.3 + a * 0.65;
      for (let i = 0; i < 70; i++) { c.fillStyle = i % 2 ? cfg.c2 : shade(cfg.c1, -0.35); c.beginPath(); c.ellipse(R() * W, R() * H, (20 + R() * 55) * S, (14 + R() * 34) * S, R() * PI, 0, PI * 2); c.fill(); }
      c.globalAlpha = 1; break;
    }
    case 'halftone': {
      c.fillStyle = '#0b0b0c'; const st = 16 * S;
      for (let y = 0; y < H; y += st) for (let x = ((y / st) % 2) * st / 2; x < W; x += st) {
        const r = st * 0.48 * Math.pow(y / H, 1.3) * (0.3 + a * 0.9); if (r > 0.6) { c.beginPath(); c.arc(x, y, r, 0, PI * 2); c.fill(); }
      }
      break;
    }
    case 'warpaint': {
      emi = true; const w = (10 + a * 12) * S;
      const strokes = [[[0.3, 0.52], [0.33, 0.7]], [[0.42, 0.51], [0.5, 0.64]], [[0.2, 0.53], [0.21, 0.63]]];
      c.globalAlpha = 0.5 + a * 0.5;
      both((sd) => strokes.forEach((s) => { const pp = s.map(([d, t]) => P(sd * d, t)); line(c, pp, w, cfg.c3); line(e, pp, w, '#fff'); }));
      const bar = [P(-0.4, 0.3), P(-0.1, 0.33), P(0.1, 0.33), P(0.4, 0.3)]; line(c, bar, w * 0.8, cfg.c3); line(e, bar, w * 0.8, '#fff');
      c.globalAlpha = 1; break;
    }
    default: break;
  }
  // decal on the forehead
  if (cfg.decal && cfg.decal !== 'none') {
    emi = true; const q = P(0, 0.27); const r = 0.1 * pxY; const k = pxX / pxY;
    for (const ctx of [c, e]) {
      ctx.save(); ctx.translate(q[0], q[1]); ctx.scale(k, 1); ctx.fillStyle = ctx === c ? cfg.c3 : '#fff'; ctx.strokeStyle = ctx.fillStyle;
      if (cfg.decal === 'x') { ctx.lineWidth = r * 0.28; ctx.lineCap = 'square'; ctx.beginPath(); ctx.moveTo(-r, -r); ctx.lineTo(r, r); ctx.moveTo(r, -r); ctx.lineTo(-r, r); ctx.stroke(); }
      else if (cfg.decal === 'diamond') { ctx.beginPath(); ctx.moveTo(0, -r * 1.1); ctx.lineTo(r * 0.8, 0); ctx.lineTo(0, r * 1.1); ctx.lineTo(-r * 0.8, 0); ctx.closePath(); ctx.fill(); }
      else if (cfg.decal === 'fox') { const s = r / 200; ctx.scale(s, s); ctx.translate(-256, -263); ctx.beginPath(); [[96, 56], [204, 172], [308, 172], [416, 56], [452, 296], [256, 470], [60, 296]].forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.fill(); }
      else if (cfg.decal === 'tag') { const txt = (cfg.tag || 'FBX').toUpperCase().slice(0, 6); ctx.font = `800 ${Math.round(r * 1.5)}px 'Big Shoulders Display', 'Arial Narrow', sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(txt, 0, 0); }
      ctx.restore();
    }
  }
  return { cv, ev, emi };
}

// ---------------------------------------------------------------- materials
const OPA = { wire: 0.16, glass: 0.55, holo: 0.4, poly: 1, glitch: 0.94 };
function finish(kind, color, shine, o) {
  const op = OPA[kind] == null ? 0.9 : OPA[kind];
  return new T.MeshStandardMaterial({ color: new T.Color(color), flatShading: true, roughness: 0.7, metalness: 0, emissive: new T.Color(color), emissiveIntensity: 0.12 + shine * 0.3, transparent: op < 0.99, opacity: op, depthWrite: op > 0.8, side: T.DoubleSide });
}
const EDGE = { wire: 1, glass: 0.85, holo: 0.7, poly: 0.35, glitch: 0.6 };
function edgesFor(mesh, color, op) {
  const l = new T.LineSegments(new T.EdgesGeometry(mesh.geometry, 26), new T.LineDashedMaterial({ color: new T.Color(color), transparent: true, opacity: op, blending: T.AdditiveBlending, depthWrite: false, dashSize: 0.14, gapSize: 0.22 }));
  l.computeLineDistances(); l.userData.edge = true; mesh.add(l); return l;
}
let HALO = null;
function haloTex() {
  if (HALO) return HALO;
  const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d');
  const gr = x.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,.35)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 64, 64); HALO = new T.CanvasTexture(c); HALO.userData.shared = true; return HALO;
}
let LINES = null;
function linesTex() {
  if (LINES) return LINES;
  const c = document.createElement('canvas'); c.width = 8; c.height = 64; const x = c.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, 8, 64); x.fillStyle = '#fff'; for (let y = 0; y < 64; y += 4) x.fillRect(0, y, 8, 1);
  x.fillStyle = 'rgba(255,255,255,.6)'; x.fillRect(0, 20, 8, 10);
  LINES = new T.CanvasTexture(c); LINES.wrapS = LINES.wrapT = T.RepeatWrapping; LINES.repeat.set(1, 6); LINES.userData.shared = true; return LINES;
}

// ---------------------------------------------------------------- parts
function eyeMesh(style, s, M, poly) {
  const G = new T.Group(); const cs = poly ? 3 : 12;
  switch (style) {
    case 'slits': {
      const w = 0.13 * s, h = 0.075 * s; const sh = new T.Shape();
      sh.moveTo(-w, 0); sh.quadraticCurveTo(0, h * 1.5, w, 0.012 * s); sh.quadraticCurveTo(0, -h * 0.5, -w, 0);
      const geo = new T.ExtrudeGeometry(sh, { depth: 0.09, bevelEnabled: false, curveSegments: cs }); geo.translate(0, -h * 0.3, -0.02);
      G.add(new T.Mesh(geo, M.glow)); break;
    }
    case 'rings': {
      G.add(new T.Mesh(new T.TorusGeometry(0.075 * s, 0.022 * s, poly ? 4 : 10, poly ? 8 : 32), M.glow));
      const inner = new T.Mesh(new T.CircleGeometry(0.058 * s, poly ? 8 : 24), M.dark); inner.position.z = -0.005; G.add(inner); break;
    }
    case 'x': for (const a of [PI / 4, -PI / 4]) { const m = new T.Mesh(new T.BoxGeometry(0.2 * s, 0.042 * s, 0.09), M.glow); m.rotation.z = a; G.add(m); } break;
    case 'pixel': { const q = 0.045 * s; for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) { const m = new T.Mesh(new T.BoxGeometry(q * 0.86, q * 0.86, 0.06 + ((i + j) % 2) * 0.04), M.glow); m.position.set((i - 1) * q, (j - 0.5) * q, 0.02); G.add(m); } break; }
    case 'dots': G.add(new T.Mesh(new T.SphereGeometry(0.058 * s, poly ? 6 : 20, poly ? 4 : 14), M.glow)); break;
    case 'lenses': {
      const cy = new T.Mesh(new T.CylinderGeometry(0.1 * s, 0.1 * s, 0.1, 8), M.glass); cy.rotation.x = PI / 2; cy.position.z = 0.03; G.add(cy);
      const r = new T.Mesh(new T.TorusGeometry(0.1 * s, 0.015 * s, 6, poly ? 8 : 32), M.glow); r.position.z = 0.08; G.add(r);
      break;
    }
    default: break;
  }
  return G;
}
function mouthMesh(style, s, j, M) {
  const G = new T.Group();
  switch (style) {
    case 'grille': {
      const h = 0.13 * s * (1 + j * 0.8);
      G.add(new T.Mesh(new T.BoxGeometry(0.36 * s, h + 0.04 * s, 0.05), M.dark));
      for (let i = 0; i < 4; i++) { const b = new T.Mesh(new T.BoxGeometry(0.03 * s, h, 0.08), M.glow); b.position.x = (i - 1.5) * 0.075 * s; G.add(b); }
      break;
    }
    case 'teeth': {
      const gap = 0.02 + j * 0.09; G.add(new T.Mesh(new T.BoxGeometry(0.32 * s, gap + 0.11 * s, 0.01), M.dark));
      for (let i = 0; i < 4; i++) {
        const x = (i - 1.5) * 0.07 * s;
        const up = new T.Mesh(new T.ConeGeometry(0.022 * s, 0.065 * s, 4), M.bone); up.rotation.x = PI; up.position.set(x, gap / 2 + 0.025 * s, 0.01); G.add(up);
        const dn = new T.Mesh(new T.ConeGeometry(0.02 * s, 0.055 * s, 4), M.bone); dn.position.set(x + 0.02 * s, -gap / 2 - 0.02 * s, 0.01); dn.userData.lower = true; G.add(dn);
      }
      break;
    }
    case 'stitch': {
      G.add(new T.Mesh(new T.BoxGeometry(0.36 * s, 0.016, 0.07), M.glow));
      for (let i = 0; i < 4; i++) { const b = new T.Mesh(new T.BoxGeometry(0.016, 0.075 * s * (1 + j * 0.5), 0.025), M.glow); b.position.x = (i - 1.5) * 0.085 * s; b.rotation.z = 0.2; G.add(b); }
      break;
    }
    case 'slots': for (let i = 0; i < 3; i++) { const w = (0.3 - (i === 0 ? 0.08 : 0)) * s; const b = new T.Mesh(new T.BoxGeometry(w, 0.024 * s, 0.08), M.glow); b.position.y = (1 - i) * 0.048 * s * (1 + j * 0.7); G.add(b); } break;
    default: break;
  }
  return G;
}
function earParts(cfg, so, M, poly) {
  const G = new T.Group(); const s = 0.6 + n01(cfg.earSize) * 0.9, tilt = (n01(cfg.earTilt) - 0.5) * 0.9, a = 0.42 + n01(cfg.earSpread) * 0.42;
  const segs = poly ? 5 : 16;
  const pair = (mk) => { for (const sd of [1, -1]) { const o = mk(sd); o.position.set(sd * Math.sin(a) * HEAD.rx * so * 0.94, Math.cos(a) * HEAD.ry * so * 0.94, -0.06); o.rotation.z = -sd * (a * 0.75 + tilt); G.add(o); } };
  switch (cfg.ears) {
    case 'fox': case 'cat': {
      const fox = cfg.ears === 'fox'; const h = (fox ? 0.62 : 0.42) * s, r = (fox ? 0.26 : 0.24) * s;
      pair(() => {
        const o = new T.Group(); const outer = new T.Mesh(new T.ConeGeometry(r, h, fox ? 4 : 3, 1), M.part); outer.geometry.translate(0, h / 2, 0); outer.scale.z = fox ? 0.45 : 0.6; if (!fox) outer.rotation.y = PI; o.add(outer);
        const inner = new T.Mesh(new T.ConeGeometry(r * 0.55, h * 0.7, 3, 1), M.part2); inner.geometry.translate(0, h * 0.35, 0); inner.scale.z = 0.3; inner.position.z = r * 0.14; inner.rotation.y = PI; o.add(inner); return o;
      });
      break;
    }
    case 'horns': pair((sd) => {
      const h = 0.78 * s; const geo = new T.ConeGeometry(0.1 * s, h, segs, poly ? 5 : 20); geo.translate(0, h / 2, 0);
      const p = geo.attributes.position; for (let i = 0; i < p.count; i++) { const t = p.getY(i) / h; p.setX(i, p.getX(i) + sd * 0.3 * s * t * t); p.setZ(i, p.getZ(i) - 0.14 * s * t); }
      geo.computeVertexNormals(); const m = new T.Mesh(geo, M.part2); m.rotation.z = sd * 0.3; return m;
    }); break;
    case 'antennae': pair(() => {
      const o = new T.Group(); const h = 0.56 * s; const st = new T.Mesh(new T.CylinderGeometry(0.013, 0.02, h, 8), M.dark); st.position.y = h / 2; o.add(st);
      const tip = new T.Mesh(new T.SphereGeometry(0.045 * s, poly ? 6 : 16, poly ? 4 : 12), M.glow); tip.position.y = h; tip.userData.tip = true; o.add(tip); return o;
    }); break;
    case 'crest': {
      for (let i = 0; i < 3; i++) {
        const b = 0.45 - i * 0.5, h = (0.2 + 0.1 * Math.sin(i * 1.3 + 1)) * s * (1 - i * 0.08);
        const sh = new T.Shape(); sh.moveTo(-0.09 * s, 0); sh.lineTo(0.08 * s, 0); sh.lineTo(-0.1 * s, h); sh.closePath();
        const geo = new T.ExtrudeGeometry(sh, { depth: 0.025, bevelEnabled: false }); geo.translate(0, -0.02, -0.0125); geo.rotateY(PI / 2);
        const m = new T.Mesh(geo, M.part2); m.position.set(0, Math.cos(b) * HEAD.ry * so * 0.97, Math.sin(b) * HEAD.rz * so * 0.97); m.rotation.x = -b + tilt * 0.4; G.add(m);
      }
      break;
    }
    case 'fins': for (const sd of [1, -1]) {
      const sh = new T.Shape(); sh.moveTo(0, 0.09 * s); sh.lineTo(0.58 * s, 0.24 * s); sh.lineTo(0.42 * s, -0.04 * s); sh.lineTo(0, -0.1 * s); sh.closePath();
      const geo = new T.ExtrudeGeometry(sh, { depth: 0.025, bevelEnabled: false }); geo.rotateY(PI / 2);
      const m = new T.Mesh(geo, M.part2); m.position.set(sd * HEAD.rx * so * (0.88 + n01(cfg.earSpread) * 0.1), 0.06, -0.12); m.rotation.x = -tilt * 0.8; m.rotation.y = sd * 0.25; G.add(m);
    } break;
    default: break;
  }
  return G;
}

// ---------------------------------------------------------------- build a whole mask
const rc = () => new T.Raycaster();
function place(obj, targets, x, y, off) {
  const r = rc(); r.set(new T.Vector3(x, y, 6), new T.Vector3(0, 0, -1));
  const h = r.intersectObjects(targets, false)[0];
  if (!h) { obj.position.set(x, y, 0.85); return obj; }
  const n = h.face.normal.clone().transformDirection(h.object.matrixWorld); if (n.z < 0) n.negate();
  obj.position.copy(h.point).addScaledVector(n, off == null ? 0.006 : off); obj.lookAt(h.point.clone().add(n)); return obj;
}
function build(cfg, o) {
  const coarse = cfg.mat === 'glitch'; const poly = true; const gAmt = cfg.onGlitch === false ? 0 : n01(cfg.glitch, 45) * (cfg.mat === 'glitch' ? 1.6 : 1);
  const G = new T.Group(); const U = { glow: [], sprites: [], eyes: [], mouth: null, shell: null, overlay: null, light: null, tips: [] };
  const B = BASES[cfg.base] || BASES.full; const so = B.k + n01(cfg.standoff) * 0.08; const shine = n01(cfg.shine);
  const tw = o.texW || 1024; const tex = drawTex(cfg, tw, tw / 2);
  const map = new T.CanvasTexture(tex.cv); map.colorSpace = T.SRGBColorSpace; map.anisotropy = 4;
  const shellMat = finish(cfg.mat, '#ffffff', shine, o); shellMat.map = map; shellMat.side = T.DoubleSide;
  const glowAmt = cfg.onGlow === false ? 0 : n01(cfg.glow, 40);
  if (tex.emi) { const em = new T.CanvasTexture(tex.ev); em.colorSpace = T.SRGBColorSpace; shellMat.emissiveMap = em; shellMat.emissive = new T.Color(cfg.glowColor); U.glow.push({ m: shellMat, base: 0.1 + glowAmt * 1.6 }); }
  const ws = coarse ? Math.round(4 * B.span) + 3 : Math.round(5 * B.span) + 4, hs = coarse ? 5 : 6;
  const shell = new T.Mesh(sphereDeformed(cfg, so, poly, ws, hs, PI / 2 - B.span * PI / 2, B.span * PI, B.t0 * PI, (B.t1 - B.t0) * PI, coarse ? 0.08 : 0.05), shellMat);
  G.add(shell); U.shell = shell; shell.userData.orig = shell.geometry.attributes.position.array.slice();
  const M = {
    glow: new T.MeshStandardMaterial({ color: new T.Color(cfg.c3), emissive: new T.Color(cfg.glowColor), emissiveIntensity: 0.3, roughness: 1, metalness: 0, flatShading: true }),
    dark: new T.MeshStandardMaterial({ color: 0x0d0d0f, roughness: 0.35, metalness: 0.2, flatShading: poly }),
    bone: new T.MeshStandardMaterial({ color: 0xf1ede2, roughness: 0.45, flatShading: poly }),
    glass: o.reduced ? new T.MeshStandardMaterial({ color: 0x050507, roughness: 0.1, metalness: 0.2 }) : new T.MeshPhysicalMaterial({ color: 0x050507, roughness: 0.05, metalness: 0.1, clearcoat: 1 }),
    part: finish(cfg.mat, cfg.c1, shine, o),
    part2: finish(cfg.mat, cfg.c2, shine, o),
  };
  U.glow.push({ m: M.glow, base: 0.25 + glowAmt * 2.4 });
  const targets = [shell];
  if (cfg.base === 'visor') {
    const vm = o.reduced ? new T.MeshStandardMaterial({ color: 0x08080a, roughness: 0.12, metalness: 0.3 }) : new T.MeshPhysicalMaterial({ color: 0x08080a, roughness: 0.06, metalness: 0.2, clearcoat: 1, clearcoatRoughness: 0.02 });
    vm.flatShading = poly; vm.side = T.DoubleSide;
    const band = new T.Mesh(sphereDeformed(cfg, so + 0.035, poly, 6, 2, PI / 2 - 0.4 * PI, 0.8 * PI, 0.39 * PI, 0.14 * PI), vm);
    G.add(band); targets.unshift(band);
  }
  if (cfg.base === 'hood') {
    const hm = finish(cfg.mat === 'wire' ? 'wire' : 'glass', cfg.c2, 0.3, o);
    const hood = new T.Mesh(new T.SphereGeometry(1, 9, 6, 0.78 * PI, 1.44 * PI, 0, 0.74 * PI), hm);
    hood.scale.set(HEAD.rx * 1.2, HEAD.ry * 1.14, HEAD.rz * 1.2); hood.position.y = 0.04; G.add(hood);
  }
  if (cfg.base === 'helmet') {
    const ring = new T.Mesh(new T.TorusGeometry(HEAD.rx * so * 1.0, 0.035, 8, poly ? 12 : 64), M.part2); ring.rotation.x = PI / 2; ring.scale.set(1, HEAD.rz / HEAD.rx, 1); ring.position.y = Math.cos(0.86 * PI) * so + 0.02; G.add(ring);
  }
  if (ABSTRACT[cfg.base]) {
    shell.visible = false; const R = rng(97 + cfg.base.length * 31); const mA = finish(cfg.mat, cfg.c1, shine, o), mB = finish(cfg.mat, cfg.c2, shine, o); U.pieces = [];
    const core = new T.Mesh(shell.geometry, M.dark); core.userData.sharedGeo = true; core.scale.setScalar(0.95); G.add(core);
    const addP = (geo, mat, x, y, z, rs) => { const m = new T.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set((R() - 0.5) * rs, (R() - 0.5) * rs, (R() - 0.5) * rs); m.userData.base = m.position.clone(); m.userData.rot = m.rotation.clone(); m.userData.ph = R() * 6.28; m.userData.gx = 0; G.add(m); U.pieces.push(m); return m; };
    const sz = 0.75 + n01(cfg.cheeks) * 0.5;
    if (cfg.base === 'shards') {
      for (let i = 0; i < 22; i++) { const th = (0.16 + R() * 0.66) * PI, ph = PI / 2 + (R() - 0.5) * 1.9, rr = so * (1.02 + R() * 0.14 + n01(cfg.standoff) * 0.1);
        const r = (0.2 + R() * 0.2) * sz; const geo = R() < 0.5 ? new T.TetrahedronGeometry(r) : new T.OctahedronGeometry(r * 0.9); geo.scale(1, 1, 0.55);
        const m = addP(geo, i % 4 === 0 ? mB : mA, -Math.cos(ph) * Math.sin(th) * HEAD.rx * rr, Math.cos(th) * HEAD.ry * rr, Math.sin(ph) * Math.sin(th) * HEAD.rz * rr, 1.6); m.lookAt(m.position.clone().multiplyScalar(2)); m.rotateZ(R() * 6.28); m.userData.rot = m.rotation.clone(); }
    } else if (cfg.base === 'monolith') {
      const hgt = 1.7 + n01(cfg.brow) * 0.5; const a = addP(new T.BoxGeometry(1.5 * sz, hgt, 0.2), shellMat, 0, 0.02, 0.98 + n01(cfg.standoff) * 0.1, 0); a.rotation.set((n01(cfg.chin) - 0.5) * 0.4, 0.14, (n01(cfg.cheeks) - 0.5) * 0.3); a.userData.rot = a.rotation.clone();
      const b = addP(new T.BoxGeometry(1.75 * sz, 0.5, 0.12), mB, 0.08, -0.45, 0.86, 0); b.rotation.set(0, -0.1, 0.2); b.userData.rot = b.rotation.clone();
      const c = addP(new T.BoxGeometry(0.3, 1.2, 0.12), mA, -0.72 * sz, 0.35, 0.8, 0); c.rotation.set(0, 0.3, -0.12); c.userData.rot = c.rotation.clone();
    } else if (cfg.base === 'eq') {
      const N = 13, w = 1.62 * sz; for (let i = 0; i < N; i++) { const u = i / (N - 1) - 0.5, x = u * w, prof = Math.cos(u * PI * 0.92), h = (0.55 + 1.35 * prof) * (0.8 + n01(cfg.brow) * 0.4);
        const geo = new T.BoxGeometry(0.085 * sz, 1, 0.14); const m = addP(geo, i % 3 === 1 ? mB : mA, x, 0.02, HEAD.rz * so * Math.sqrt(Math.max(0.1, 1 - (x / (HEAD.rx * so * 1.05)) ** 2)) + 0.04 + n01(cfg.standoff) * 0.08, 0); m.rotation.set(0, Math.asin(Math.max(-0.9, Math.min(0.9, x / (HEAD.rx * so * 1.1)))), 0); m.userData.rot = m.rotation.clone(); m.userData.eq = h; m.userData.u = u; m.scale.y = h; }
    } else if (cfg.base === 'vortex') {
      core.material = finish('poly', cfg.c2, 0.2, o); core.material.opacity = 1; core.material.transparent = false; core.scale.setScalar(0.97);
      const NR = 8, fz = HEAD.rz * so * 1.0 + 0.04 + n01(cfg.standoff) * 0.1, depth = 0.07 + n01(cfg.brow) * 0.07;
      for (let i = 0; i < NR; i++) { const r = (0.74 - i * 0.082) * sz; const m = addP(new T.TorusGeometry(r, 0.03 + (i === 0 ? 0.02 : 0), 4, 6), i === NR - 1 ? M.glow : i % 2 ? mB : mA, 0, 0.0, fz - i * depth, 0); m.rotation.set(0, 0, i * 0.26); m.userData.rot = m.rotation.clone(); m.userData.ring = i; }
      const back = addP(new T.CircleGeometry(0.2 * sz, 6), M.glow, 0, 0, fz - NR * depth - 0.02, 0); back.userData.ring = NR;
      const N = o.thumb ? 140 : 420, pos = new Float32Array(N * 3), R2 = rng(9001), P = { ang: [], r: [], y0: [], vr: [], sp: [], N };
      for (let i = 0; i < N; i++) { P.ang.push(R2() * PI * 2); P.r.push(1.3 + R2() * 2.6); P.y0.push(-1.6 + R2() * 3.4); P.vr.push(0); P.sp.push(0.5 + R2()); }
      const pg = new T.BufferGeometry(); pg.setAttribute('position', new T.BufferAttribute(pos, 3));
      const pm = new T.PointsMaterial({ color: new T.Color(cfg.glowColor), size: o.thumb ? 0.09 : 0.06, transparent: true, opacity: 0.9, blending: T.AdditiveBlending, depthWrite: false });
      const pts = new T.Points(pg, pm); pts.frustumCulled = false; pts.userData.free = true; G.add(pts); U.vortex = { pts, P }; vortexPlace(U.vortex);
    } else if (cfg.base === 'vu') {
      const N = 11; for (let i = 0; i < N; i++) { const u = i / (N - 1), y = 0.72 - u * 1.5, q = Math.max(0.15, 1 - (y / 1.02) ** 2), half = HEAD.rx * so * Math.sqrt(q) * (0.95 + (n01(cfg.cheeks) - 0.5) * 0.3), z = HEAD.rz * so * Math.sqrt(q) * 0.92 + 0.06 + n01(cfg.standoff) * 0.08;
        const geo = new T.BoxGeometry(1, 0.085, 0.16); const m = addP(geo, i % 4 === 1 ? mB : mA, 0, y, z, 0); m.userData.rot = m.rotation.clone(); m.userData.vu = half * 2; m.scale.x = half * 2; }
      const rays = new T.Group(); rays.position.set(0, 0.1, -0.75); rays.userData.free = true; G.add(rays); U.rays = [];
      const NR = 48, r0 = 1.28 + n01(cfg.brow) * 0.2; for (let i = 0; i < NR; i++) { const a = i / NR * PI * 2; const geo = new T.BoxGeometry(0.05, 1, 0.05); geo.translate(0, 0.5, 0); const m = new T.Mesh(geo, i % 6 === 0 ? mB : shellMat); m.position.set(Math.cos(a) * r0, Math.sin(a) * r0, 0); m.rotation.z = a - PI / 2; m.userData.ph = hash3(i, 3, 7) * 6.28; m.userData.len = 0.25 + hash3(i, 9, 1) * 0.45; rays.add(m); U.rays.push(m); edgesFor(m, cfg.glowColor, 0.5); }
      const ring = new T.Mesh(new T.TorusGeometry(r0 - 0.06, 0.018, 4, 64), M.glow); rays.add(ring); U.rayGroup = rays;
    } else if (cfg.base === 'slices') {
      const N = 15, top = 0.95, bot = -1.0; for (let i = 0; i < N; i++) { const u = i / (N - 1), y = top + (bot - top) * u, q = Math.max(0.12, 1 - (y / 1.08) ** 2), rx = HEAD.rx * so * 1.04 * Math.sqrt(q) * (1 + (n01(cfg.cheeks) - 0.5) * 0.3 * Math.exp(-(((y + 0.1) / 0.3) ** 2))), rz = HEAD.rz * so * 1.04 * Math.sqrt(q);
        const geo = new T.CylinderGeometry(1, 1, 0.055, 7, 1, false, -PI * 0.62, PI * 1.24); geo.scale(rx, 1, rz + n01(cfg.brow) * 0.12 * Math.exp(-(((y - 0.35) / 0.12) ** 2)) + n01(cfg.chin) * 0.14 * Math.max(0, -y - 0.5));
        const m = addP(geo, i % 4 === 2 ? mB : mA, 0, y, 0, 0); m.rotation.set(0, 0, 0); m.userData.rot = m.rotation.clone(); m.userData.slice = u; }
    } else if (cfg.base === 'halo') {
      core.material = mB; const rs = [[1.18, 0.4, 0, 1.55], [1.32, -0.5, 0.6, 1.7], [1.05, 1.2, -0.3, 1.3], [1.45, 0.1, 1.4, 1.8]];
      rs.forEach(([r, ax, az, arc], i) => { const m = addP(new T.TorusGeometry(r * sz * 0.9, 0.03 + (i % 2) * 0.02, 4, 28, arc * PI), i % 2 ? mA : shellMat, 0, 0.05, 0, 0); m.rotation.set(PI / 2 + ax, 0, az); m.userData.rot = m.rotation.clone(); m.userData.spin = (i % 2 ? -1 : 1) * (0.25 + i * 0.12); });
    } else if (cfg.base === 'screen') {
      core.visible = false; const bw = 1.75 * sz, bh = 1.4 + n01(cfg.brow) * 0.2, bd = 1.3;
      const box = addP(new T.BoxGeometry(bw, bh, bd), mA, 0, 0.08, 0.02, 0); box.rotation.set((n01(cfg.chin) - 0.5) * 0.2, 0, (n01(cfg.cheeks) - 0.5) * 0.12); box.userData.rot = box.rotation.clone();
      const scr = new T.Mesh(new T.PlaneGeometry(bw * 0.82, bh * 0.76), new T.MeshStandardMaterial({ color: 0x050507, emissive: new T.Color(cfg.c2), emissiveIntensity: 0.25, roughness: 0.2, flatShading: true })); scr.position.z = bd / 2 + 0.012; box.add(scr); box.userData.screen = scr;
      const stand = addP(new T.CylinderGeometry(0.05, 0.05, 0.5, 6), mB, 0.5 * sz, 0.08 + bh / 2 + 0.22, -0.2, 0); stand.rotation.set(0, 0, -0.35); stand.userData.rot = stand.rotation.clone();
    } else {
      const st = 0.19 * sz, cz = 0.17 * sz; for (let gx = -5; gx <= 5; gx++) for (let gy = -6; gy <= 5; gy++) { const x = gx * st, y = gy * st + 0.02, q = (x / HEAD.rx) ** 2 + (y / HEAD.ry) ** 2; if (q > 1.02 || (R() < 0.12 && q > 0.25)) continue;
        const z = HEAD.rz * so * Math.sqrt(Math.max(0.05, 1 - q)) + R() * 0.07 * (1 + n01(cfg.brow)); addP(new T.BoxGeometry(cz, cz, cz), R() < 0.18 ? mB : mA, x, y, z, 0.3); }
    }
    if (cfg.base === 'slices') core.scale.setScalar(0.9);
    targets.length = 0; if (cfg.base === 'screen') { G.updateMatrixWorld(true); targets.push(U.pieces[0].userData.screen); } else if (cfg.base === 'halo') targets.push(core); else { U.pieces.forEach((p) => targets.push(p)); targets.push(core); }
  }
  G.updateMatrixWorld(true);
  // eyes
  const es = 0.6 + n01(cfg.eyeSize) * 0.9, ex = 0.2 + n01(cfg.eyeGap) * 0.16, et = (n01(cfg.eyeTilt) - 0.5) * 1.0, ey = 0.12;
  if (cfg.eyes === 'band') {
    const w = ex + 0.14 * es; const bt = Math.acos(ey / (HEAD.ry * so)); const hh = 0.03 * es;
    const band = new T.Mesh(sphereDeformed(cfg, so + (cfg.base === 'visor' ? 0.045 : 0.012), poly, poly ? 8 : 40, 2, PI / 2 - w, w * 2, bt - hh, hh * 2), M.glow);
    G.add(band); U.eyes.push(band);
  } else {
    for (const sd of [1, -1]) { const e = eyeMesh(cfg.eyes, es, M, poly); place(e, targets, sd * ex, ey, 0.01); e.rotateZ(-sd * et); G.add(e); U.eyes.push(e); }
  }
  // mouth
  const mg = mouthMesh(cfg.mouth, 0.6 + n01(cfg.mouthSize) * 0.9, n01(cfg.jaw, 20), M);
  if (mg.children.length) { place(mg, [shell], 0, -0.4 - n01(cfg.jaw, 20) * 0.05, 0.008); G.add(mg); U.mouth = mg; }
  // ears & horns
  const ears = earParts(cfg, so, M, poly); G.add(ears); ears.traverse((x) => { if (x.userData.tip) U.tips.push(x); });
  // glow halos + light
  if (!o.reduced && !o.thumb) {
    const spm = new T.SpriteMaterial({ map: haloTex(), color: new T.Color(cfg.glowColor), blending: T.AdditiveBlending, transparent: true, depthWrite: false, opacity: 0 });
    const spots = cfg.eyes === 'band' ? [[0, ey]] : [[ex, ey], [-ex, ey]];
    spots.forEach(([x, y]) => { const sp = new T.Sprite(spm); place(sp, targets, x, y, 0.06); sp.scale.setScalar((cfg.eyes === 'band' ? 0.9 : 0.5) * es * (0.5 + n01(cfg.bloom, 50) * 1.6)); G.add(sp); U.sprites.push(sp); });
    U.spm = spm; U.spBase = glowAmt * 0.7 * (0.4 + n01(cfg.bloom, 50) * 1.2);
  }
  const L = new T.PointLight(new T.Color(cfg.glowColor), 0, 3, 2); L.position.set(0, 0.05, 1.5); G.add(L); U.light = L; U.lightBase = glowAmt * 5;
  if (o.thumb) { M.glow.emissiveIntensity = 0.25 + glowAmt * 2.4; if (tex.emi) shellMat.emissiveIntensity = 0.1 + glowAmt * 1.6; L.intensity = U.lightBase * 0.6; }
  // shimmer overlay
  if (!o.reduced && !ABSTRACT[cfg.base] && cfg.onShim !== false && cfg.shimmer && cfg.shimmer !== 'none') {
    const om = new T.MeshBasicMaterial({ map: linesTex(), color: new T.Color(cfg.shimmer === 'holo' ? '#7cc8ff' : cfg.glowColor), transparent: true, opacity: (cfg.shimmer === 'holo' ? 0.22 : 0.16) * (0.3 + n01(cfg.shimAmt, 50) * 1.6), blending: T.AdditiveBlending, depthWrite: false, side: T.FrontSide });
    const ov = new T.Mesh(shell.geometry, om); ov.scale.setScalar(1.012); G.add(ov); U.overlay = ov; ov.userData.sharedGeo = true;
  }
  const ec = cfg.mat === 'wire' || cfg.mat === 'glass' ? cfg.glowColor : cfg.c3, eo = (EDGE[cfg.mat] == null ? 0.5 : EDGE[cfg.mat]) * (0.55 + shine * 0.45);
  U.shellEdge = edgesFor(shell, ec, eo); U.edgeO = eo;
  if (U.pieces) U.pieces.forEach((p) => edgesFor(p, ec, eo));
  U.eqBase = cfg.base === 'eq'; U.poly = poly; U.gAmt = gAmt; U.glitch = gAmt > 0.02 && !o.reduced;
  if (U.glitch && !o.thumb && !ABSTRACT[cfg.base]) {
    U.ghosts = [['#ff3b3b', 1], ['#3be4ff', -1]].map(([c, sd]) => { const gm = new T.Mesh(shell.geometry, new T.MeshBasicMaterial({ color: new T.Color(c), transparent: true, opacity: 0.4, blending: T.AdditiveBlending, depthWrite: false, side: T.FrontSide })); gm.userData.sharedGeo = true; gm.userData.sd = sd; gm.visible = false; gm.scale.setScalar(1.004); G.add(gm); return gm; });
  }
  if (o.thumb && gAmt > 0.25) { const a = shell.geometry.attributes.position; const orig = shell.userData.orig; const bands = [[0.18, 0.08 * gAmt], [-0.35, -0.12 * gAmt]]; for (let i = 0; i < a.count; i++) for (const [yb, sh] of bands) if (Math.abs(orig[i * 3 + 1] - yb) < 0.08) a.array[i * 3] = orig[i * 3] + sh; a.needsUpdate = true; U.shellEdge.geometry.dispose(); U.shellEdge.geometry = new T.EdgesGeometry(shell.geometry, 26); U.shellEdge.computeLineDistances(); }
  if (!o.reduced && cfg.onAura !== false && n01(cfg.aura, 0) > 0.01) {
    const am = new T.MeshBasicMaterial({ color: new T.Color(cfg.glowColor), transparent: true, opacity: 0, blending: T.AdditiveBlending, depthWrite: false, side: T.BackSide });
    const au = new T.Mesh(new T.SphereGeometry(1, 16, 12), am); au.scale.set(HEAD.rx * 1.32, HEAD.ry * 1.25, HEAD.rz * 1.32); au.position.y = 0.05; G.add(au); U.aura = au; U.auraBase = n01(cfg.aura) * 0.22;
    if (o.thumb) am.opacity = U.auraBase;
  }
  if (!o.reduced && !o.thumb && cfg.onParts !== false && cfg.particles && cfg.particles !== 'none') {
    const N = Math.round(30 + n01(cfg.partAmt, 50) * 220), pos = new Float32Array(N * 3), R = rng(4242), seed = [];
    const gl = cfg.particles === 'glitch';
    for (let i = 0; i < N; i++) { const a = R() * PI * 2, r = 0.95 + R() * 0.9; if (gl) { pos[i * 3] = (R() - 0.5) * 3.6; pos[i * 3 + 1] = -1.4 + R() * 3.2; pos[i * 3 + 2] = -0.5 - R() * 1.6; } else { pos[i * 3] = Math.cos(a) * r; pos[i * 3 + 1] = -1.6 + R() * 3.4; pos[i * 3 + 2] = Math.sin(a) * r; } seed.push(R()); }
    const pg = new T.BufferGeometry(); pg.setAttribute('position', new T.BufferAttribute(pos, 3));
    const data = cfg.particles === 'data';
    const pm = new T.PointsMaterial({ color: new T.Color(data ? cfg.c3 : cfg.glowColor), size: data ? 0.1 : 0.075, transparent: true, opacity: 0.85, blending: T.AdditiveBlending, depthWrite: false, sizeAttenuation: true });
    if (gl) { pm.size = 0.075; pm.sizeAttenuation = true; }
    const pts = new T.Points(pg, pm); pts.userData.free = true; pts.frustumCulled = false; G.add(pts); U.parts = { pts, seed, data, gl, speed: 0.25 + n01(cfg.partAmt, 50) * 0.35 };
    if (gl) { const gh = new T.Points(pg, new T.PointsMaterial({ color: 0x3be4ff, size: 0.075, transparent: true, opacity: 0.6, blending: T.AdditiveBlending, depthWrite: false })); gh.userData.sharedGeo = true; pts.add(gh); U.parts.ghost = gh; }
  }
  U.edgeAnim = cfg.onEdges === false ? 'off' : (cfg.edgeAnim || 'march'); U.edgeSpeed = 0.3 + n01(cfg.edgeSpeed, 40) * 2.2;
  if (U.shellEdge && cfg.onEdges === false) U.shellEdge.visible = false;
  if (U.pieces && cfg.onEdges === false) U.pieces.forEach((p) => p.children.forEach((c) => (c.visible = false)));
  U.gMode = cfg.glitchMode || 'slice'; U.gRate = cfg.glitchRate || 'bar'; U.pixel = cfg.onPixel === false ? 0 : n01(cfg.pixel, 0);
  G.userData = U; return G;
}
function vortexPlace(V) { const a = V.pts.geometry.attributes.position, P = V.P; for (let i = 0; i < P.N; i++) { const r = P.r[i], k = Math.min(1, (r - 0.7) / 2.2); a.setXYZ(i, Math.cos(P.ang[i]) * r, 0.1 + P.y0[i] * k, Math.sin(P.ang[i]) * r * 0.8 - 0.35); } a.needsUpdate = true; }
function dispose(G) {
  G.traverse((x) => {
    if (x.geometry && !x.userData.sharedGeo) x.geometry.dispose();
    const ms = x.material ? (Array.isArray(x.material) ? x.material : [x.material]) : [];
    ms.forEach((m) => { ['map', 'emissiveMap'].forEach((k) => { if (m[k] && !m[k].userData.shared) m[k].dispose(); }); m.dispose(); });
  });
}
function mannequin(thumb) {
  // Techy wireframe stand-in: a scanned person idling (head, neck, torso, arms) with an occluding dark core.
  const G = new T.Group(); const wire = new T.MeshBasicMaterial({ color: 0x7cc8ff, wireframe: true, transparent: true, opacity: thumb ? 0.18 : 0.3, depthWrite: false });
  const core = new T.MeshBasicMaterial({ color: 0x0a0a0d });
  const both = (geo, parent, sx, sy, sz) => { const a = new T.Mesh(geo, core), b = new T.Mesh(geo, wire); a.scale.set(sx * 0.985, sy * 0.985, sz * 0.985); b.scale.set(sx, sy, sz); parent.add(a, b); return b; };
  const head = new T.SphereGeometry(1, 9, 6); const hw = both(head, G, HEAD.rx * 0.97, HEAD.ry * 0.97, HEAD.rz * 0.97); hw.material = wire.clone(); hw.material.opacity = 0.08;
  if (!thumb) { const pts = new T.Points(head, new T.PointsMaterial({ color: 0xe9e5da, size: 0.03, transparent: true, opacity: 0.55, depthWrite: false })); pts.scale.set(HEAD.rx * 0.97, HEAD.ry * 0.97, HEAD.rz * 0.97); pts.material.opacity = 0.25; G.add(pts); }
  const body = new T.Group(); G.add(body);
  const prof = [[0.001, -0.62], [0.27, -0.72], [0.3, -1.25], [0.55, -1.5], [1.05, -1.66], [1.28, -1.86], [1.3, -2.3], [1.18, -3.0], [1.02, -3.7], [0.001, -3.75]].map(([x, y]) => new T.Vector2(x, y));
  const torso = both(new T.LatheGeometry(prof, 18), body, 1, 1, 0.58);
  const arms = [];
  for (const sd of [1, -1]) {
    const arm = new T.Group(); arm.position.set(sd * 1.22, -1.9, 0); arm.rotation.z = sd * 0.14; body.add(arm);
    const up = new T.CylinderGeometry(0.19, 0.15, 1.5, 10, 4); up.translate(0, -0.75, 0); both(up, arm, 1, 1, 1);
    const fore = new T.Group(); fore.position.y = -1.5; fore.rotation.x = -0.25; arm.add(fore);
    const lo = new T.CylinderGeometry(0.15, 0.11, 1.35, 10, 4); lo.translate(0, -0.67, 0); both(lo, fore, 1, 1, 1);
    arms.push(arm);
  }
  let ring = null;

  G.userData = { body, torso, arms, ring };
  return G;
}
function envFor(r) {
  const pm = new T.PMREMGenerator(r); const s = new T.Scene();
  s.add(new T.Mesh(new T.BoxGeometry(20, 20, 20), new T.MeshBasicMaterial({ color: 0x24242a, side: T.BackSide })));
  const floor = new T.Mesh(new T.PlaneGeometry(20, 20), new T.MeshBasicMaterial({ color: 0x08080a, side: T.DoubleSide })); floor.rotation.x = -PI / 2; floor.position.y = -5; s.add(floor);
  const panel = (w, h, col, pos) => { const m = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ color: col, side: T.DoubleSide })); m.position.set(...pos); m.lookAt(0, 0, 0); s.add(m); };
  panel(8, 4, new T.Color(3, 3, 2.9), [0, 7, 6]);
  panel(2, 9, new T.Color(3, 0.8, 0.4), [7, 0, -4]);
  panel(2, 9, new T.Color(0.5, 1.2, 2.2), [-7, 0, -3]);
  panel(10, 1, new T.Color(1.2, 1.2, 1.2), [0, -6, 5]);
  const t = pm.fromScene(s, 0.03).texture; pm.dispose(); return t;
}
function lights(scene) {
  scene.add(new T.HemisphereLight(0x2a2a33, 0x050505, 0.9));
  const key = new T.DirectionalLight(0xfff1e0, 2.4); key.position.set(-2.5, 3, 4); scene.add(key);
  const rim = new T.DirectionalLight(0xff4b2b, 3.4); rim.position.set(3.5, 1.5, -3); scene.add(rim);
  const fill = new T.DirectionalLight(0x7cc8ff, 1.2); fill.position.set(-4, 0.5, -2); scene.add(fill);
}

// ---------------------------------------------------------------- the element
class MaskHead extends HTMLElement {
  static get observedAttributes() { return ['cfg', 'mode', 'beat', 'reduced', 'still', 'trigger', 'act']; }
  constructor() { super(); this.cfg = null; this.mode = 'turntable'; this.beat = false; this.reduced = false; this.still = false; this.yaw = 0.32; this.pitch = 0.04; this.dirty = true; this.resume = 0; this.lastBeat = -1; }
  attributeChangedCallback(n, o, v) {
    if (o === v) return;
    if (n === 'cfg') { try { this.cfg = JSON.parse(v); this.dirty = true; } catch (e) {} }
    else if (n === 'mode') this.mode = v || 'turntable';
    else if (n === 'act') { const nm = (v || '').split(':')[0]; this.act = nm ? { nm, t0: performance.now() / 1000 } : null; if (nm) { const I = this.idle; if (I) { I.ty = 0; I.tp = 0; } if (/drop|burst/.test(nm)) this.forceT = performance.now() / 1000; } }
    else if (n === 'trigger') { if (v && v !== '0') this.forceT = performance.now() / 1000; }
    else if (n === 'reduced') { this.reduced = v === '1'; this.dirty = true; if (this.r) { this.r.setPixelRatio(this.reduced ? 1 : Math.min(2, devicePixelRatio)); this.scene.environment = this.reduced ? null : this.env; this.fit(); } }
    else this[n] = v === '1';
  }
  connectedCallback() {
    this.style.display = 'block'; this.style.width = '100%'; this.style.height = '100%'; this.style.position = 'relative'; this.style.touchAction = 'none';
    ready.then(() => { this.init(); if (!this.raf) this.raf = requestAnimationFrame(this.tick); }).catch((e) => console.warn('three.js failed to load', e));
  }
  disconnectedCallback() { cancelAnimationFrame(this.raf); this.raf = 0; if (this.ro) this.ro.disconnect(); }
  init() {
    if (!this.r) {
      const r = (this.r = new T.WebGLRenderer({ antialias: true, alpha: true }));
      r.setPixelRatio(this.reduced ? 1 : Math.min(2, devicePixelRatio)); r.outputColorSpace = T.SRGBColorSpace; r.toneMapping = T.ACESFilmicToneMapping; r.toneMappingExposure = 1.05;
      r.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;cursor:grab';
      this.scene = new T.Scene(); lights(this.scene); this.env = envFor(r); if (!this.reduced) this.scene.environment = this.env;
      this.cam = new T.PerspectiveCamera(26, 1, 0.1, 60);
      this.root = new T.Group(); this.scene.add(this.root); this.man = mannequin(); this.root.add(this.man);
      const cv = r.domElement;
      cv.addEventListener('pointerdown', (e) => { if (this.mode === 'live') return; this.drag = { x: e.clientX, y: e.clientY }; cv.setPointerCapture(e.pointerId); cv.style.cursor = 'grabbing'; });
      cv.addEventListener('pointermove', (e) => { if (!this.drag) return; this.yaw += (e.clientX - this.drag.x) * 0.012; this.pitch = cl(this.pitch + (e.clientY - this.drag.y) * 0.005, -0.35, 0.4); this.drag = { x: e.clientX, y: e.clientY }; });
      const up = () => { if (!this.drag) return; this.drag = null; this.resume = performance.now() + 1600; cv.style.cursor = 'grab'; };
      cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    }
    if (!this.wave) { this.wave = document.createElement('canvas'); this.wave.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;opacity:0;transition:opacity .6s'; const W = []; const R = rng(77); for (let i = 0; i < 64 * 6; i++) { const b = i / 6, bar = Math.floor(b / 4), inD = bar >= 8, gap = b >= 31 && b < 32, k = Math.exp(-(b % 1) * 5); W.push(gap ? 0.02 : inD ? 0.55 + 0.4 * k * (0.7 + R() * 0.3) : (0.12 + 0.38 * (b / 32) ** 1.6) * (0.6 + R() * 0.4)); } this.waveData = W; }
    if (this.wave.parentNode !== this) this.insertBefore(this.wave, this.firstChild);
    if (this.r.domElement.parentNode !== this) this.appendChild(this.r.domElement);
    this.ro = new ResizeObserver(() => this.fit()); this.ro.observe(this); this.fit();
  }
  fit() {
    if (this.wave) { const dp = Math.min(2, devicePixelRatio); this.wave.width = Math.round((this.clientWidth || 1) * dp); this.wave.height = Math.round((this.clientHeight || 1) * dp); }
    const px = this.mask ? this.mask.userData.pixel || 0 : 0; const pr = (this.reduced ? 1 : Math.min(2, devicePixelRatio)) * (1 - px * 0.93); this.r.setPixelRatio(Math.max(0.07, pr)); this.r.domElement.style.imageRendering = px > 0.02 ? 'pixelated' : 'auto';
    const w = this.clientWidth || 1, h = this.clientHeight || 1; this.r.setSize(w, h, false);
    const asp = w / h; this.cam.aspect = asp; const d = 10.8 * Math.max(1, 0.9 / asp);
    this.cam.position.set(0, 0.25, d); this.cam.lookAt(0, -0.45, 0); this.cam.updateProjectionMatrix();
  }
  rebuild() {
    this.dirty = false; if (this.mask) { this.root.remove(this.mask); dispose(this.mask); }
    if (!this.back) { this.back = new T.Group(); this.scene.add(this.back); this.backV = { y: 0 }; }
    this.back.children.slice().forEach((c) => { this.back.remove(c); dispose(c); });
    this.mask = build(this.cfg, { reduced: this.reduced }); this.root.add(this.mask);
    const free = []; this.mask.traverse((x) => { if (x.userData.free) free.push(x); }); free.forEach((x) => { x.parent.remove(x); this.back.add(x); });
    if ((this.pxApplied || 0) !== this.mask.userData.pixel) { this.pxApplied = this.mask.userData.pixel; this.fit(); }
    const prev = this.lastCfg; this.lastCfg = this.cfg;
    if (!this.scan) { this.scan = new T.Mesh(new T.PlaneGeometry(2.8, 0.03), new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: T.AdditiveBlending, depthWrite: false })); this.scan.position.z = 1.25; this.scan.visible = false; this.root.add(this.scan); }
    this.scan.material.color.set(this.cfg.glowColor || '#ff4b2b');
    if (!prev) return; const ch = Object.keys(this.cfg).filter((k) => this.cfg[k] !== prev[k]); if (!ch.length) return;
    const now = performance.now() / 1000; if (now - (this.pulseT || 0) > 0.7) this.pulseT = now;
    const I = this.idle; if (!I || this.drag) return;
    const side = ch.some((k) => /^ear|^base$|^standoff$/.test(k)), face = ch.some((k) => /^eye|^mouth|^jaw/.test(k));
    I.ty = (side ? 0.6 : face ? 0 : 0.28) - this.yaw; I.tp = face ? 0 : 0.05; I.next = now + 3.2;
  }
  tick = (now) => {
    this.raf = requestAnimationFrame(this.tick);
    if (!this.r) return;
    if (this.reduced && now - (this.lastDraw || 0) < 32) return;
    const dt = Math.min(0.05, (now - (this.lastDraw || now)) / 1000); this.lastDraw = now; const t = now / 1000;
    if (this.dirty && this.cfg) this.rebuild();
    const rm = reducedMotion(); const U = this.mask ? this.mask.userData : null; const mode = this.mode;
    this.man.visible = mode !== 'live';
    if (mode === 'noface' || mode === 'live') { this.yaw += (0 - this.yaw) * 0.08; }

    const bp = 60 / 128, ph = (t % bp) / bp;
    let rx = this.pitch, ry = this.yaw, py = 0, px = 0;
    if (!rm) {
      if (mode === 'clip') { const k = Math.pow(Math.abs(Math.sin(PI * t / bp)), 2); rx += 0.09 * k; py = -0.03 * k; ry = this.yaw + 0.25 * Math.sin(t * 0.5); }
      if (mode === 'live') { ry += 0.22 * Math.sin(t * 0.6); rx += 0.05 * Math.sin(t * 0.9); px = 0.06 * Math.sin(t * 0.4); }
      if (mode === 'heads') { ry += 0.12 * Math.sin(t * 0.5); rx += 0.03 * Math.sin(t * 0.8); }
    }
    this.root.rotation.set(rx, ry, 0); this.root.position.set(px, py, 0);
    const M = this.man.userData;
    if (M.body) {
      const I = this.idle || (this.idle = { ty: 0, tp: 0, y: 0, p: 0, vy: 0, vp: 0, next: 0 });
      if (!rm && mode !== 'noface' && mode !== 'live') {
        if (this.act) { I.ty = 0; I.tp = 0; I.next = t + 2; }
        if (t > I.next) { I.ty = (Math.random() - 0.5) * 0.7; I.tp = (Math.random() - 0.4) * 0.18; I.next = t + 2.6 + Math.random() * 3.2; }
        const k = 26, d = 2 * Math.sqrt(k) * 0.9;
        I.vy += ((I.ty - I.y) * k - I.vy * d) * dt; I.y += I.vy * dt; I.vp += ((I.tp - I.p) * k - I.vp * d) * dt; I.p += I.vp * dt;
      } else { I.y *= 0.9; I.p *= 0.9; }
      const br = rm ? 0 : Math.sin(t * 1.25), sw = rm ? 0 : Math.sin(t * 0.42);
      this.root.rotation.y += I.y; this.root.rotation.x += I.p + 0.012 * br; this.root.rotation.z = rm ? 0 : 0.03 * sw;
      this.root.position.x += 0.05 * sw; this.root.position.y += 0.02 * br;
      M.body.rotation.set(-(I.p + 0.012 * br) * 0.85, -I.y * 0.8, -0.03 * sw * 1.4);
      M.body.position.y = -0.02 * br;
      if (this.act && !rm) { const a = t - this.act.t0, e = Math.min(1, a / 0.35), R = this.root.rotation, P = this.root.position, B = M.body.rotation;
        switch (this.act.nm) {
          case 'headbang': { const k = Math.pow(Math.abs(Math.sin(a * PI * 128 / 60)), 3); R.x += e * 0.3 * k; P.y -= e * 0.06 * k; B.x -= e * 0.2 * k; break; }
          case 'twirl': { const c = a % 2.6, s = Math.min(1, c / 1.2), sm = s * s * (3 - 2 * s); R.y += sm * PI * 2; break; }
          case 'shake': { const env = Math.exp(-((a % 2.2) * 2.2)); R.y += e * 0.35 * Math.sin(a * 17) * env; break; }
          case 'lookup': { R.x -= e * 0.32; R.y += e * 0.35 * Math.sin(a * 1.1); B.x += e * 0.22; break; }
          case 'bounce': { const k = Math.abs(Math.sin(a * 5.2)); P.y += e * 0.16 * k; R.z += e * 0.05 * Math.sin(a * 2.6); break; }
          case 'tilt': { R.z += e * 0.32 * Math.sin(a * 2.1); R.y += e * 0.25 * Math.sin(a * 1.05); break; }
          case 'float': { P.y += e * 0.2 * Math.sin(a * 1.6); R.y += e * 0.6 * Math.sin(a * 0.8); R.x += e * 0.08 * Math.sin(a * 1.6 + 1); break; }
          case 'drop': { if (a % 4 < 0.02 && a > 1) this.forceT = t; const k = Math.max(0, 1 - ((t - (this.forceT || -9)) / 0.5)); R.x += 0.18 * k; P.y -= 0.08 * k; break; }
          case 'burst': { if (a % 3 < 0.02 && a > 1) this.forceT = t; R.y += e * 0.2 * Math.sin(a * 3); break; }
          case 'peek': { R.y += e * (a % 3 < 1.5 ? 0.7 : -0.7) * Math.min(1, (a % 1.5) * 3); break; }
        } }
      M.torso.scale.set(1 + 0.012 * br, 1 + 0.014 * br, 0.58 * (1 + 0.02 * br));
      M.arms.forEach((a, i) => { const sd = i ? -1 : 1; a.position.y = -1.9 + 0.03 * br; a.rotation.z = sd * (0.13 + 0.02 * br) + 0.03 * sw; a.rotation.x = rm ? 0 : 0.05 * Math.sin(t * 0.9 + i * 1.7) - I.y * 0.05 * sd; });
    }

    const forced = this.forceT && t - this.forceT < 5, beatOn = this.beat || forced;
    const loop = bp * 64, lp = forced ? bp * 30 + (t - this.forceT) : t % loop, bar = Math.floor(lp / (bp * 4)), inDrop = bar >= 8, sinceDrop = lp - bp * 32, build = inDrop ? 1 : lp / (bp * 32);
    const bi = Math.floor(t / bp); if (bi !== this.lastBeat) { this.lastBeat = bi; if (this.beat) this.dispatchEvent(new CustomEvent('maskbeat', { detail: { b: bi % 4, drop: inDrop, bar: bar % 8 } })); }
    if (U) {
      let env = 1; const br = this.cfg.beat || 'kick';
      if (beatOn && br !== 'off') {
        if (rm || br === 'steady') env = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(t * 2 * PI / 4));
        else if (!inDrop) env = 0.3 + 0.45 * build * build;
        else env = 0.55 + 0.6 * Math.exp(-ph * 5) + 1.3 * Math.exp(-sinceDrop * 2.2); }
      U.glow.forEach((gm) => (gm.m.emissiveIntensity = gm.base * env));
      if (U.spm) U.spm.opacity = U.spBase * env; if (U.light) U.light.intensity = U.lightBase * env;
      const kickE = beatOn && inDrop && !rm ? Math.exp(-ph * 6) : 0, hatE = beatOn && !rm ? Math.exp(-(((t / bp) + 0.5) % 1) * 9) * (inDrop ? 1 : build * build) : 0, bld = beatOn && !inDrop ? build : 0, bar8 = Math.floor(t / (bp * 2)) % 2;
      if (U.eqBase && !rm) { this.root.rotation.x += 0.11 * kickE; this.root.position.y -= 0.06 * kickE; this.root.rotation.z += (bar8 ? 1 : -1) * 0.05 * kickE; }
      if (U.pieces) U.pieces.forEach((p) => { const b = p.userData.base, ph = p.userData.ph, r0 = p.userData.rot; const a = rm ? 0 : 1; p.position.set(b.x + p.userData.gx + a * 0.012 * Math.sin(t * 0.6 + ph), b.y + a * 0.02 * Math.sin(t * 0.9 + ph), b.z + a * 0.015 * Math.sin(t * 0.7 + ph)); p.rotation.set(r0.x, r0.y + a * 0.08 * Math.sin(t * 0.5 + ph), r0.z + (p.userData.spin ? a * t * p.userData.spin : 0)); if (p.userData.eq) { const u = p.userData.u, gc = Math.exp(-(u * u) / 0.04), sweep = Math.exp(-(((u + 0.5) - ((t / (bp * 4)) % 1)) ** 2) / 0.01);
          let lv = !a ? 1 : beatOn ? (inDrop ? 0.45 + 1.05 * kickE * gc + 0.55 * hatE * (1 - gc) + 0.12 * Math.sin(t * 9 + ph * 5) : 0.3 + 0.5 * bld * bld + 0.35 * sweep * bld + 0.25 * hatE * (1 - gc)) : 0.7 + 0.16 * Math.sin(t * 2.3 + ph * 3) + 0.1 * Math.sin(t * 5.1 + u * 9);
          p.scale.y = p.userData.eq * Math.max(0.12, lv); p.position.z = b.z + 0.16 * kickE * gc + 0.05 * hatE * (1 - gc); p.rotation.x = r0.x - 0.25 * kickE * gc * Math.sign(u || 1) * 0.3; }
        if (p.userData.ring != null) { const i = p.userData.ring, kick = a ? Math.max(0, env - 0.6) : 0; p.position.z = b.z + a * 0.03 * Math.sin(t * 1.6 - i * 0.7) + 0.32 * kick * (1 - i / 9); p.rotation.z = r0.z + a * t * (0.18 + i * 0.05) * (i % 2 ? -1 : 1); const sc = 1 + 0.18 * kick * (i / 8); p.scale.set(sc, sc, 1); }
        if (p.userData.vu) { const k = a ? 0.55 + 0.25 * Math.sin(t * 2.7 + ph * 4) + 0.35 * (env - 0.5) : 1; p.scale.x = p.userData.vu * Math.max(0.2, Math.min(1.15, k)); }
        if (p.userData.slice != null) { const w = a ? Math.sin(t * 3.1 - p.userData.slice * 7) : 0, kick = a ? Math.max(0, env - 0.6) : 0; p.position.z = b.z + 0.05 * w + 0.22 * kick * Math.sin(p.userData.slice * PI); p.position.x = b.x + 0.03 * Math.sin(t * 1.7 - p.userData.slice * 5); const sc = 1 + 0.03 * w + 0.12 * kick; p.scale.set(sc, 1, sc); } });
      if (U.vortex && !rm) { const V = U.vortex, P = V.P; const cyc = beatOn ? null : t % 7; const edge = beatOn ? (inDrop && !this.wasDrop) : (cyc < (this.lastCyc == null ? 99 : this.lastCyc)); this.lastCyc = cyc;
        const pull = beatOn ? (inDrop ? 0.5 : 0.35 + 2.4 * build * build) : 0.5 + (cyc / 7) * 1.4;
        for (let i = 0; i < P.N; i++) { if (edge) P.vr[i] = 3.5 + P.sp[i] * 5; P.vr[i] += (-pull * P.sp[i] - P.vr[i]) * Math.min(1, dt * 1.6); P.r[i] += P.vr[i] * dt; P.ang[i] += dt * (0.9 / Math.max(0.6, P.r[i])) * P.sp[i] * (1 + pull * 0.4);
          if (P.r[i] < 0.75) { P.r[i] = 3.2 + hash3(i, t, 1) * 1.2; P.ang[i] = hash3(i, t, 2) * PI * 2; } if (P.r[i] > 7) P.r[i] = 7; }
        vortexPlace(V); V.pts.material.opacity = 0.55 + 0.4 * Math.min(1, env); }
      this.wasDrop = inDrop;
      if (U.rays) { const a = rm ? 0 : 1; U.rayGroup.rotation.z = a * t * 0.12; U.rays.forEach((m, i) => { const w = a ? Math.max(0.12, 0.45 + 0.35 * Math.sin(t * 3.3 + m.userData.ph) * Math.sin(t * 1.1 + i * 0.4) + 0.9 * Math.max(0, env - 0.55)) : 0.6; m.scale.y = m.userData.len * w * 1.6; }); }
      if (this.scan) { const k = (t - (this.pulseT || -9)) / 0.6; this.scan.visible = k >= 0 && k < 1; if (this.scan.visible) { this.scan.position.y = 1.5 - k * 2.9; this.scan.material.opacity = 0.9 * (1 - k); } const boost = k >= 0 && k < 1 ? 1 + 0.8 * (1 - k) : 1; U.glow.forEach((gm) => (gm.m.emissiveIntensity *= boost)); }
      if (U.aura) U.aura.material.opacity = U.auraBase * (0.55 + 0.45 * env);
      if (U.parts && !rm && U.parts.gl) { const p = U.parts, a = p.pts.geometry.attributes.position, slot = Math.floor(t / 0.34), fire = slot !== p.slot; p.slot = slot;
        for (let i = 0; i < a.count; i++) { if (fire && hash3(i, slot, 4) < 0.12 + (beatOn && inDrop ? 0.25 : 0)) a.setXYZ(i, (hash3(i, slot, 1) - 0.5) * 3.6, -1.4 + hash3(i, slot, 2) * 3.2, -0.5 - hash3(i, slot, 3) * 1.6); else a.setY(i, a.getY(i) + Math.sin(t * 0.7 + p.seed[i] * 20) * dt * 0.04); }
        a.needsUpdate = true; const on = (t % 0.34) < 0.06 && hash3(slot, 9, 9) < 0.6; p.ghost.position.x = on ? 0.06 : 0.015; p.ghost.visible = true; p.pts.position.x = on ? (hash3(slot, 1, 1) - 0.5) * 0.12 : 0; p.pts.material.opacity = 0.55 + 0.4 * env; }
      else if (U.parts && !rm) { const p = U.parts, a = p.pts.geometry.attributes.position; for (let i = 0; i < a.count; i++) { let y = a.getY(i) + (p.data ? -1 : 1) * dt * p.speed * (0.4 + p.seed[i]); if (y > 1.9) y = -1.6; if (y < -1.6) y = 1.9; a.setY(i, y); if (!p.data) a.setX(i, a.getX(i) + Math.sin(t * 0.8 + p.seed[i] * 9) * dt * 0.05); } a.needsUpdate = true; p.pts.material.opacity = 0.5 + 0.4 * env; }
      if (U.shellEdge && U.edgeAnim === 'pulse') { U.shellEdge.material.opacity = U.edgeO * (0.25 + 0.9 * (env - 0.35)); U.shellEdge.material.dashOffset = 0; }
      if (U.shellEdge && !rm && U.edgeAnim === 'march') { U.shellEdge.material.dashSize = 0.14; U.shellEdge.material.gapSize = 0.22; U.shellEdge.material.opacity = U.edgeO * (0.75 + 0.25 * Math.sin(t * 1.4)); if (!U.edgeMat) U.edgeMat = U.shellEdge.material; U.edgeMat.userData.o = (U.edgeMat.userData.o || 0) + dt * 0.25 * U.edgeSpeed; U.shellEdge.geometry.attributes.lineDistance && (U.shellEdge.material.dashOffset = -U.edgeMat.userData.o); }
      if (U.overlay) U.overlay.material.map.offset.y = rm ? 0 : -t * 0.08;
      const talk = mode === 'live' || mode === 'heads';
      if (U.mouth) U.mouth.scale.y = talk && !rm ? 1 + 0.55 * Math.max(0, Math.sin(t * 9)) * (Math.sin(t * 1.3) > -0.2 ? 1 : 0) : 1;
      const blink = mode === 'heads' && (t % 3.6) < 0.14 ? 0.12 : 1; U.eyes.forEach((e) => (e.scale.y = blink));
      if (U.glitch && !rm && (beatOn || U.gOn)) {
        const barLen = bp * 4, slot = Math.floor(t / barLen), win = 0.09 + U.gAmt * 0.07, on = beatOn && inDrop && (U.gRate === 'during' ? (lp % barLen) < win : sinceDrop < win * 2.2);
        const a = U.shell.geometry.attributes.position; const orig = U.shell.userData.orig;
        if (slot !== U.gslot || on !== U.gOn) {
          U.gslot = slot; a.array.set(orig);
          if (on && U.gMode === 'scatter') { for (let i = 0; i < a.count; i++) if (hash3(slot, i, 3) < 0.4) { const k = (hash3(slot, i, 6) - 0.5) * 0.22 * U.gAmt; a.array[i * 3] = orig[i * 3] + k; a.array[i * 3 + 1] = orig[i * 3 + 1] + k * 0.6; a.array[i * 3 + 2] = orig[i * 3 + 2] + Math.abs(k); } }
          if (on && U.gMode === 'slice') { const nb = 1 + Math.floor(hash3(slot, 5, 5) * 3); for (let b = 0; b < nb; b++) { const yb = (hash3(slot, b, 2) - 0.5) * 1.6, w = 0.04 + hash3(slot, b, 8) * 0.1, sh = (hash3(slot, b, 4) - 0.5) * 0.3 * U.gAmt; for (let i = 0; i < a.count; i++) if (Math.abs(orig[i * 3 + 1] - yb) < w) { a.array[i * 3] = orig[i * 3] + sh; a.array[i * 3 + 2] = orig[i * 3 + 2] + Math.abs(sh) * 0.3; } } }
          a.needsUpdate = true; U.gOn = on;
          if (U.shellEdge) { U.shellEdge.geometry.dispose(); U.shellEdge.geometry = new T.EdgesGeometry(U.shell.geometry, 26); U.shellEdge.computeLineDistances(); }
        }
        if (U.pieces) U.pieces.forEach((p, i) => { p.userData.gx = on && hash3(slot, i, 1) < 0.35 ? (hash3(slot, i, 2) - 0.5) * 0.34 * U.gAmt : 0; });
        if (U.ghosts) U.ghosts.forEach((gm) => { gm.visible = on; gm.position.x = gm.userData.sd * (U.gMode === 'rgb' ? 0.06 + 0.1 * U.gAmt : 0.02 + 0.05 * U.gAmt); gm.material.opacity = 0.25 + 0.25 * U.gAmt; });
        this.mask.position.x = on ? (hash3(slot, 3, 3) - 0.5) * 0.04 * U.gAmt : 0;
      }
    }
    if (this.back) { const B = this.back, k = Math.min(1, dt * 1.4), tgtY = this.root.rotation.y * 0.35; B.position.x += (this.root.position.x * 0.6 - B.position.x) * k; B.position.y += (this.root.position.y * 0.5 + (rm ? 0 : 0.06 * Math.sin(t * 0.5)) - B.position.y) * k; B.rotation.y += (tgtY + (rm ? 0 : 0.12 * Math.sin(t * 0.23)) - B.rotation.y) * k * 0.6; B.rotation.z = rm ? 0 : 0.04 * Math.sin(t * 0.31); B.rotation.x = rm ? 0 : 0.03 * Math.sin(t * 0.27 + 1); B.visible = this.man.visible || this.mode === 'live'; }
    this.drawWave(beatOn, lp / (bp * 64), inDrop);
    this.r.render(this.scene, this.cam);
  };
  drawWave(on, pos, inDrop) {
    const c = this.wave; if (!c) return; on = on && this.beat; const want = on && this.mode !== 'live' ? '1' : '0'; if (c.style.opacity !== want) c.style.opacity = want; if (!on) return;
    const x = c.getContext('2d'), W = c.width, H = c.height, D = this.waveData, n = D.length, dp = W / (this.clientWidth || 1);
    x.clearRect(0, 0, W, H); const pad = 28 * dp, ww = W - pad * 2, cy = H * 0.5, amp = H * 0.16, bw = ww / n; const ph = Math.floor(pos * n); const dropX = pad + ww * 0.5;
    x.fillStyle = 'rgba(255,75,43,0.035)'; x.fillRect(dropX, cy - amp * 1.15, ww * 0.5, amp * 2.3);
    for (let i = 0; i < n; i++) { const h = Math.max(1 * dp, D[i] * amp), d = i >= n / 2, played = i <= ph; x.fillStyle = d ? (played ? 'rgba(255,75,43,0.34)' : 'rgba(255,75,43,0.13)') : (played ? 'rgba(233,229,218,0.26)' : 'rgba(233,229,218,0.09)'); x.fillRect(pad + i * bw, cy - h, Math.max(1, bw - 1 * dp), h * 2); }
    const px = pad + ww * pos; x.fillStyle = 'rgba(233,229,218,0.55)'; x.fillRect(px, cy - amp * 1.25, 1 * dp, amp * 2.5);
    x.font = `700 ${11 * dp}px 'JetBrains Mono', monospace`; x.textBaseline = 'top'; x.fillStyle = 'rgba(141,138,130,0.9)'; x.fillText('BUILD', pad, cy + amp * 1.3); x.fillStyle = inDrop ? 'rgba(255,75,43,0.95)' : 'rgba(255,75,43,0.6)'; x.fillText('◆ DROP', dropX + 4 * dp, cy + amp * 1.3);
  }
}
if (!customElements.get('mask-head')) customElements.define('mask-head', MaskHead);

// ---------------------------------------------------------------- thumbnails (shared offscreen renderer, one per frame)
let TR = null; const cache = new Map(); const done = new Map(); const q = []; let busy = false;
function renderThumb(cfg, opt) {
  if (!TR) {
    const r = new T.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }); r.setPixelRatio(1); r.setSize(240, 240, false); r.outputColorSpace = T.SRGBColorSpace; r.toneMapping = T.ACESFilmicToneMapping;
    const scene = new T.Scene(); lights(scene); scene.environment = envFor(r); const cam = new T.PerspectiveCamera(26, 1, 0.1, 60); const root = new T.Group(); scene.add(root); const man = mannequin(true); root.add(man);
    TR = { r, scene, cam, root, man };
  }
  const { r, scene, cam, root, man } = TR; opt = opt || {};
  const G = build(cfg, { texW: 512, thumb: true }); root.add(G); root.rotation.set(0.04, opt.yaw == null ? 0.5 : opt.yaw, 0); man.visible = opt.frame === 'full' || opt.frame === 'wide' || !opt.frame;
  if (opt.frame === 'eyes') { cam.position.set(0, 0.2, 3.1); cam.lookAt(0, 0.1, 0); } else if (opt.frame === 'mouth') { cam.position.set(0, -0.25, 3.1); cam.lookAt(0, -0.32, 0); } else if (opt.frame === 'face') { cam.position.set(0, 0.1, 4.3); cam.lookAt(0, 0.02, 0); } else if (opt.frame === 'wide') { cam.position.set(0, 0.2, 7.4); cam.lookAt(0, -0.05, 0); } else { cam.position.set(0, 0.45, 6.6); cam.lookAt(0, 0.3, 0); }
  cam.updateProjectionMatrix(); r.render(scene, cam); const d64 = r.domElement.toDataURL('image/webp', 0.88); const bin = atob(d64.split(',')[1]); const arr = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i); const url = URL.createObjectURL(new Blob([arr], { type: 'image/webp' })); root.remove(G); dispose(G); return url;
}
function pump() {
  if (busy) return; busy = true;
  const step = () => { const j = q.shift(); if (!j) { busy = false; return; } let u = ''; try { u = renderThumb(j.cfg, j.opt); } catch (e) { console.warn(e); } done.set(j.k, u); j.res(u); requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
window.MaskKit = {
  ready,
  peek(cfg, opt) { return done.get(JSON.stringify([cfg, opt || {}])); },
  thumb(cfg, opt) {
    const k = JSON.stringify([cfg, opt || {}]); if (cache.has(k)) return cache.get(k);
    const p = ready.then(() => new Promise((res) => { q.push({ cfg, opt, res, k }); pump(); }));
    cache.set(k, p); if (cache.size > 500) { const f = cache.keys().next().value; cache.delete(f); done.delete(f); } return p;
  },
};
