/* FoxBox design prototype: one RAF loop that paints every canvas (TD previews, the VISUALS stage, tiles, meters).
   A simulated 140 BPM track drives kick/snare/bass/drop/section/voice. Flashes are capped at 3/s and
   prefers-reduced-motion slows motion and removes flashes. */
(function () {
  'use strict';
  const PAL = {
    ember: { bg: '#050506', fg: '#f2efe6', ac: '#ff4b2b', al: '#ffb23e' },
    ice: { bg: '#03060a', fg: '#e8f4ff', ac: '#29a8ff', al: '#7cf0ff' },
    toxic: { bg: '#040602', fg: '#f1ffe0', ac: '#b6ff2e', al: '#2effc4' },
    bone: { bg: '#0d0b08', fg: '#efe6d2', ac: '#c9b48a', al: '#ff4b2b' },
    void: { bg: '#000000', fg: '#ffffff', ac: '#8a5cff', al: '#ff2e9a' },
  };
  const rm = window.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const PLAN = [['INTRO', 8], ['BUILD', 8], ['DROP', 16], ['BREAK', 8], ['BUILD', 8], ['DROP', 16]];
  const TOTAL = 64;
  const M = { playing: true, bpm: 140, start: 0 };
  const bl = () => 60 / M.bpm;
  M.start = performance.now() / 1000 - bl() * 4 * 12.5;
  const fr = (x) => x - Math.floor(x), cl = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x), mix = (a, b, t) => a + (b - a) * t;
  const H1 = (n) => fr(Math.sin(n * 127.1 + 311.7) * 43758.5453);
  const rgbOf = (h) => { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map((x) => x + x).join(''); const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
  const rgba = (h, a) => { const [r, g, b] = rgbOf(h); return `rgba(${r},${g},${b},${a})`; };
  const mixHex = (a, b, t) => { const A = rgbOf(a), B = rgbOf(b); return `rgb(${A.map((v, i) => Math.round(mix(v, B[i], t))).join(',')})`; };
  let C = null, frameId = 0, lastFlash = -9;

  function computeClock(wall) {
    const b = bl(), t = wall - M.start, beats = t / b, bar = (((beats / 4) % TOTAL) + TOTAL) % TOTAL;
    let acc = 0, i = 0;
    for (; i < PLAN.length; i++) { if (bar < acc + PLAN[i][1]) break; acc += PLAN[i][1]; }
    const sec = PLAN[i][0], secLen = PLAN[i][1], inSec = bar - acc, next = PLAN[(i + 1) % PLAN.length][0];
    const toNextBars = secLen - inSec, ph = fr(beats), bn = Math.floor(beats) % 4;
    let kick = 0, snare = 0, bass = 0, drop = 0, energy = 0.3;
    const ek = Math.exp(-ph * 7), es = Math.exp(-ph * 9);
    if (sec === 'DROP') { kick = ek; snare = bn % 2 ? es : 0; bass = 0.55 + 0.45 * Math.exp(-fr(beats * 2) * 3); drop = Math.exp(-inSec * 0.7); energy = 1; }
    else if (sec === 'BUILD') { kick = inSec >= secLen - 2 ? Math.exp(-fr(beats * 4) * 6) * 0.85 : ek * 0.6; snare = bn % 2 ? es * 0.7 : 0; bass = 0.22; energy = 0.5 + 0.45 * (inSec / secLen); }
    else if (sec === 'BREAK') { snare = bn === 3 ? es * 0.5 : 0; bass = 0.14; energy = 0.35; }
    else { kick = bn % 2 === 0 ? ek * 0.45 : 0; bass = 0.1; energy = 0.3; }
    const voice = sec !== 'DROP' ? (Math.sin(t * 1.1) > 0 ? Math.abs(Math.sin(t * 7.3)) * 0.8 : 0) : (Math.sin(t * 0.7) > 0.6 ? 0.5 : 0);
    const c = { wall, t, mt: t, beats, ph, bn, bar, barInSec: inSec, sec, secLen, next, toNext: toNextBars * 4 * b, toNextBars, kick, snare, bass, drop, section: Math.exp(-inSec * 1.6), voice, energy, playing: true, bpm: M.bpm, reduced: rm.matches };
    if (!M.playing) { const s = 0.5 + 0.5 * Math.sin(t * 0.9); Object.assign(c, { kick: 0.06 * s, snare: 0, bass: 0.08 * s, drop: 0, section: 0, voice: 0, energy: 0.15, sec: 'NO TRACK', next: '', playing: false }); c.mt = t * 0.35; }
    if (rm.matches) { c.kick *= 0.3; c.snare *= 0.3; c.drop = Math.min(c.drop, 0.25); c.mt *= 0.25; }
    c.level = cl(0.2 + c.kick * 0.5 + c.bass * 0.4 + c.snare * 0.3 + c.voice * 0.2) * (c.playing ? 1 : 0.25);
    return c;
  }
  const env = (c, s) => (!s || s === 'none' ? 0 : c[s] ?? 0);
  function canFlash() { if (rm.matches) return false; if (C.wall - lastFlash < 0.34) return false; lastFlash = C.wall; return true; }

  /* ---------- the subject ---------- */
  let FIG = null;
  function figure(c) {
    const t = c.mt;
    const sway = Math.sin(t * 0.9) * 0.03 + Math.sin(t * 2.1) * 0.008, bob = c.kick * 0.014 + Math.sin(t * 1.6) * 0.005;
    const hx = sway * 1.3, hy = 0.31 + bob, sx = sway * 0.7, shY = 0.57 + bob * 0.6;
    const up = cl((c.sec === 'DROP' ? 0.55 : 0) + c.drop * 0.6);
    const lu = c.sec === 'DROP' ? 0.25 + 0.3 * c.kick : 0.04 + 0.04 * Math.sin(t * 1.3);
    const sL = [sx - 0.23, shY], sR = [sx + 0.23, shY];
    const eR = [mix(sx + 0.31, sx + 0.4, up), mix(0.79, 0.38, up)], hR = [mix(sx + 0.32, sx + 0.33, up), mix(0.99, 0.13, up)];
    const eL = [mix(sx - 0.31, sx - 0.36, lu), mix(0.79, 0.66, lu)], hL = [mix(sx - 0.32, sx - 0.2, lu), mix(0.99, 0.46, lu)];
    const F = { hx, hy, rx: 0.074, ry: 0.098, sx, shY, sL, sR, eL, eR, hL, hR, tag: 'n' };
    F.pts = [[hx, hy - 0.098], [hx - 0.03, hy - 0.008], [hx + 0.03, hy - 0.008], [hx, hy + 0.025], [hx, hy + 0.06], [hx, hy + 0.098], [hx - 0.072, hy], [hx + 0.072, hy], [sx, 0.5], sL, sR, eL, eR, hL, hR, [sx, 0.7], [sx - 0.2, 0.93], [sx + 0.2, 0.93], [sx - 0.12, 0.63], [sx + 0.12, 0.63], [sx, 0.86]];
    const r = 0.3 * (1 + c.kick * 0.08);
    F.ring = { r, pts: Array.from({ length: 20 }, (_, i) => { const a = (i / 20) * Math.PI * 2 + t * 0.2; return [Math.cos(a) * r, 0.5 + Math.sin(a) * r]; }) };
    return F;
  }
  function bodyPath(ctx, F, X, Y, S) {
    ctx.beginPath();
    ctx.ellipse(X + F.hx * S, Y + F.hy * S, F.rx * S, F.ry * S, 0, 0, Math.PI * 2);
    const nx = X + ((F.hx + F.sx) / 2) * S;
    ctx.rect(nx - 0.036 * S, Y + (F.hy + 0.06) * S, 0.072 * S, (F.shY - F.hy - 0.02) * S);
    const x0 = X + F.sx * S, sy = Y + F.shY * S;
    ctx.moveTo(x0 - 0.05 * S, sy - 0.07 * S);
    ctx.quadraticCurveTo(x0 - 0.22 * S, sy - 0.05 * S, x0 - 0.26 * S, sy + 0.03 * S);
    ctx.lineTo(x0 - 0.29 * S, Y + 1.1 * S); ctx.lineTo(x0 + 0.29 * S, Y + 1.1 * S); ctx.lineTo(x0 + 0.26 * S, sy + 0.03 * S);
    ctx.quadraticCurveTo(x0 + 0.22 * S, sy - 0.05 * S, x0 + 0.05 * S, sy - 0.07 * S);
    ctx.closePath();
  }
  function armsPath(ctx, F, X, Y, S) {
    ctx.beginPath();
    for (const [s, e, h] of [[F.sL, F.eL, F.hL], [F.sR, F.eR, F.hR]]) { ctx.moveTo(X + s[0] * S, Y + s[1] * S); ctx.lineTo(X + e[0] * S, Y + e[1] * S); ctx.lineTo(X + h[0] * S, Y + h[1] * S); }
  }
  function fillSubject(ctx, F, g, col, src) {
    const { X, Y, S } = g;
    ctx.fillStyle = col; ctx.strokeStyle = col;
    if (src === 'stage') { ctx.lineWidth = 0.09 * S; ctx.beginPath(); ctx.arc(X, Y + 0.5 * S, F.ring.r * S, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.arc(X, Y + 0.5 * S, F.ring.r * S * 0.3, 0, Math.PI * 2); ctx.fill(); return; }
    bodyPath(ctx, F, X, Y, S); ctx.fill();
    armsPath(ctx, F, X, Y, S); ctx.lineWidth = 0.085 * S; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
    if (F.hands) for (const h of F.hands) { if (!h) continue; ctx.beginPath(); ctx.arc(X + h.palm[0] * S, Y + h.palm[1] * S, 0.034 * S, 0, Math.PI * 2); ctx.fill(); ctx.lineWidth = 0.019 * S; ctx.beginPath(); for (const t of h.tips) { ctx.moveTo(X + h.palm[0] * S, Y + h.palm[1] * S); ctx.lineTo(X + t[0] * S, Y + t[1] * S); } ctx.stroke(); }
  }
  function outlineSubject(ctx, F, g, col, w, src, inner) {
    const { X, Y, S } = g;
    ctx.strokeStyle = col; ctx.lineWidth = w;
    if (src === 'stage') { ctx.beginPath(); ctx.arc(X, Y + 0.5 * S, F.ring.r * S * 1.15, 0, Math.PI * 2); ctx.arc(X, Y + 0.5 * S, F.ring.r * S * 0.85, 0, Math.PI * 2); ctx.stroke(); return; }
    bodyPath(ctx, F, X, Y, S); ctx.stroke();
    armsPath(ctx, F, X, Y, S); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (!inner) { ctx.lineWidth = w; ctx.stroke(); return; }
    ctx.lineWidth = 0.085 * S + w * 2; ctx.stroke(); ctx.save(); ctx.shadowBlur = 0; ctx.strokeStyle = inner; ctx.lineWidth = 0.085 * S; ctx.stroke(); ctx.restore();
  }
  const geo = (W, H) => ({ X: W / 2, Y: H * 0.03, S: H * 0.97 });
  const subjPts = (F, src) => (src === 'stage' ? F.ring.pts : F.pts);

  let masks = new Map();
  const moff = document.createElement('canvas'), mctx = moff.getContext('2d', { willReadFrequently: true });
  function maskFor(W, H, cols, rows, src) {
    const key = `${W}x${H}:${cols}x${rows}:${src}:${FIG.tag}`;
    let m = masks.get(key); if (m) return m;
    moff.width = cols; moff.height = rows;
    mctx.setTransform(cols / W, 0, 0, rows / H, 0, 0); mctx.clearRect(0, 0, W, H);
    fillSubject(mctx, FIG, geo(W, H), '#fff', src);
    const d = mctx.getImageData(0, 0, cols, rows).data, a = new Float32Array(cols * rows);
    for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3] / 255;
    m = { cols, rows, a, at: (x, y) => (x < 0 || y < 0 || x >= cols || y >= rows ? 0 : a[y * cols + x]) };
    masks.set(key, m); return m;
  }

  function faceFeatures(ctx, F, g, col) {
    const { X, Y, S } = g, cx = X + F.hx * S, cy = Y + F.hy * S;
    ctx.fillStyle = col; ctx.strokeStyle = col; ctx.lineCap = 'round';
    for (const s of [-1, 1]) {
      ctx.beginPath(); ctx.ellipse(cx + s * 0.03 * S, cy - 0.006 * S, 0.016 * S, 0.008 * S, 0, 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 0.007 * S; ctx.beginPath(); ctx.moveTo(cx + s * 0.012 * S, cy - 0.03 * S); ctx.lineTo(cx + s * 0.05 * S, cy - 0.026 * S); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(cx, cy + 0.0 * S); ctx.lineTo(cx - 0.008 * S, cy + 0.03 * S); ctx.lineTo(cx + 0.006 * S, cy + 0.033 * S); ctx.lineWidth = 0.005 * S; ctx.stroke();
    ctx.lineWidth = 0.008 * S; ctx.beginPath(); ctx.moveTo(cx - 0.02 * S, cy + 0.058 * S); ctx.quadraticCurveTo(cx, cy + 0.064 * S, cx + 0.02 * S, cy + 0.058 * S); ctx.stroke();
  }
  function lowpoly(ctx, F, g, pal, c, style) {
    const { X, Y, S } = g, cx = X + F.hx * S, cy = Y + F.hy * S, rx = F.rx * S * 1.2, ry = F.ry * S * 1.16, j = c.kick * 0.05;
    if (style === 'mosaic') {
      const cs = Math.max(4, 0.026 * S);
      for (let y = cy - ry; y < cy + ry; y += cs) for (let x = cx - rx; x < cx + rx; x += cs) {
        const dx = (x + cs / 2 - cx) / rx, dy = (y + cs / 2 - cy) / ry; if (dx * dx + dy * dy > 1.05) continue;
        const h = H1(Math.floor(x / cs) * 13 + Math.floor(y / cs) * 7 + Math.floor(c.beats));
        ctx.fillStyle = mixHex('#1c1b1e', '#6d6a64', h); ctx.fillRect(x, y, cs + 0.5, cs + 0.5);
      }
      return;
    }
    if (style === 'popups') {
      for (let k = 0; k < 9; k++) {
        const h = H1(k * 3.1 + Math.floor(c.beats / 2)), w = (0.05 + h * 0.06) * S, hh = w * 0.7;
        const x = cx + (H1(k * 7.7) - 0.5) * rx * 1.6 - w / 2, y = cy + (H1(k * 5.3) - 0.5) * ry * 1.6 - hh / 2;
        ctx.fillStyle = '#e9e5da'; ctx.fillRect(x, y, w, hh); ctx.fillStyle = k % 3 ? pal.ac : '#0b0b0c'; ctx.fillRect(x, y, w, Math.max(3, hh * 0.2));
        ctx.strokeStyle = '#0b0b0c'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, w, hh);
      }
      return;
    }
    if (style === 'glitch' || style === 'depth') {
      for (let k = 0; k < 14; k++) {
        const y = cy - ry + (k / 14) * ry * 2, hh = (ry * 2) / 14 + 1, off = (H1(k + Math.floor(c.t * 12)) - 0.5) * rx * (style === 'depth' ? 0.4 : 0.9);
        ctx.fillStyle = k % 2 ? rgba(pal.ac, 0.95) : rgba('#7cc8ff', 0.9); if (style === 'depth') ctx.fillStyle = mixHex('#141416', '#3b3a40', H1(k));
        ctx.fillRect(cx - rx + off, y, rx * 2, hh);
      }
      return;
    }
    const r1 = [], r2 = [];
    for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2 + 0.3; r1.push([cx + Math.cos(a) * rx * 0.5, cy + Math.sin(a) * ry * 0.5]); }
    for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2 + 0.05, k = 1 + (H1(i + 3) - 0.5) * 0.12 + j; r2.push([cx + Math.cos(a) * rx * k, cy + Math.sin(a) * ry * k]); }
    const C0 = [cx, cy - ry * 0.05], tris = [];
    for (let i = 0; i < 6; i++) {
      const a = r1[i], b = r1[(i + 1) % 6], o0 = r2[2 * i], o1 = r2[2 * i + 1], o2 = r2[(2 * i + 2) % 12];
      tris.push([C0, a, b], [a, o0, o1], [a, o1, b], [b, o1, o2]);
    }
    const base = style === 'mask' ? '#7cc8ff' : pal.ac;
    tris.forEach((tr, k) => {
      ctx.beginPath(); ctx.moveTo(tr[0][0], tr[0][1]); ctx.lineTo(tr[1][0], tr[1][1]); ctx.lineTo(tr[2][0], tr[2][1]); ctx.closePath();
      ctx.fillStyle = mixHex(base, '#0b0b0c', 0.15 + H1(k * 1.7) * 0.6); ctx.fill();
      ctx.strokeStyle = rgba('#e9e5da', 0.35); ctx.lineWidth = 1; ctx.stroke();
    });
  }

  /* ---------- hands (simulated MediaPipe gesture_recognizer: 21 landmarks/hand; here palm + 5 tips) ---------- */
  const HANDS_FX = { fwindows: 'windows', strings: 'strings', portal: 'portal' };
  let GC = {};
  const ease = (t) => { t = cl(t); return t * t * (3 - 2 * t); };
  function handAt(px, py, side, closed, open) {
    const palm = [px + side * 0.028, py + 0.068], tips = [];
    tips.push(closed ? [px + side * 0.004, py + 0.004] : [px - side * (0.03 + open * 0.02), py + 0.022]);
    tips.push(closed ? [px, py] : [px + side * 0.004, py - 0.036 - open * 0.022]);
    for (let k = 0; k < 3; k++) { const curl = closed || open < 0.5 ? 0.55 : 0; tips.push([palm[0] + side * (0.012 + k * 0.014) * (1 + open), palm[1] - (0.078 - k * 0.008) * (1 - curl) - open * 0.02]); }
    return { palm, tips, pinch: [px, py], closed, open };
  }
  function gesture(c, mode) {
    if (GC[mode]) return GC[mode];
    const T = 5.5, t = c.mt, k = Math.floor(t / T), p = fr(t / T);
    const seed = (j) => ({ cx: (H1(j * 1.3) - 0.5) * 0.42, cy: 0.34 + H1(j * 2.7) * 0.2, w: 0.16 + H1(j * 3.1) * 0.2, h: 0.11 + H1(j * 5.9) * 0.13 });
    const G = { mode, k, p };
    if (mode === 'windows') {
      const S = seed(k), rise = ease(p / 0.15), sp = ease((p - 0.18) / 0.37), drop = ease((p - 0.72) / 0.28), closed = p > 0.12 && p < 0.6;
      const yo = (1 - rise) * 0.35 + drop * 0.3, L = [S.cx - (S.w / 2) * sp - 0.012, S.cy - (S.h / 2) * sp + yo], R = [S.cx + (S.w / 2) * sp + 0.012, S.cy + (S.h / 2) * sp + yo];
      const CL = 6, k0 = Math.floor(k / CL) * CL;
      G.open = k % CL === CL - 1 && p > 0.72;
      G.L = handAt(L[0], L[1], -1, closed, G.open ? 1 : 0.3); G.R = handAt(R[0], R[1], 1, closed, G.open ? 1 : 0.3);
      G.active = p > 0.18 && p < 0.6 ? { x: S.cx - (S.w / 2) * sp, y: S.cy - (S.h / 2) * sp, w: S.w * sp, h: S.h * sp } : null;
      G.wins = [];
      for (let j = Math.max(k0, k - 5); j < k; j++) { const q = seed(j); G.wins.push({ x: q.cx - q.w / 2, y: q.cy - q.h / 2, w: q.w, h: q.h, j }); }
      if (p >= 0.6) G.wins.push({ x: S.cx - S.w / 2, y: S.cy - S.h / 2, w: S.w, h: S.h, j: k });
      G.spread = sp;
    } else if (mode === 'strings') {
      const d = 0.1 + 0.16 * (0.5 + 0.5 * Math.sin(t * 1.1)), cy = 0.47 + 0.04 * Math.sin(t * 0.7), cx = 0.03 * Math.sin(t * 0.5);
      G.L = handAt(cx - d, cy, -1, false, 1); G.R = handAt(cx + d, cy + 0.02 * Math.sin(t * 1.7), 1, false, 1); G.spread = (d - 0.1) / 0.16;
    } else {
      const r = ease((p - 0.1) / 0.4) * (1 - ease((p - 0.85) / 0.15)), px = 0.14 + 0.05 * Math.sin(t * 0.6), py = 0.4 + 0.04 * Math.cos(t * 0.8);
      G.R = handAt(px, py, 1, r < 0.05, 0); G.R.tips[1] = [px + 0.012, py - 0.02 - r * 0.08]; G.R.tips[0] = [px - 0.022, py + 0.02 + r * 0.05];
      G.portal = { x: px - 0.11 - r * 0.06, y: py - 0.02, r: 0.04 + r * 0.16 };
      G.L = handAt(-0.27, 0.9, -1, false, 0.2); G.spread = r;
    }
    GC[mode] = G; return G;
  }
  function figWithHands(G) {
    const F = { ...FIG };
    const arm = (h, side) => { const sh = side < 0 ? F.sL : F.sR, pm = h.palm; return [[sh[0] + (pm[0] - sh[0]) * 0.45 + side * 0.09, Math.max(sh[1], pm[1]) + 0.14], pm]; };
    if (G.L) [F.eL, F.hL] = arm(G.L, -1);
    if (G.R) [F.eR, F.hR] = arm(G.R, 1);
    F.hands = [G.L, G.R]; F.tag = 'g' + G.mode; return F;
  }
  function drawHands(ctx, G, g, pal, D, m) {
    const P = (t) => [g.X + t[0] * g.S, g.Y + t[1] * g.S];
    ctx.font = `700 ${11 * D}px 'JetBrains Mono',monospace`;
    for (const h of [G.L, G.R]) {
      if (!h) continue; const pm = P(h.palm);
      ctx.strokeStyle = rgba(pal.fg, 0.85); ctx.lineWidth = 1.5 * D;
      h.tips.forEach((t) => { const q = P(t), mid = [(pm[0] + q[0]) / 2, (pm[1] + q[1]) / 2]; ctx.beginPath(); ctx.moveTo(pm[0], pm[1]); ctx.lineTo(q[0], q[1]); ctx.stroke(); ctx.fillStyle = pal.fg; ctx.fillRect(mid[0] - 1.5 * D, mid[1] - 1.5 * D, 3 * D, 3 * D); });
      ctx.fillStyle = pal.bg; ctx.strokeStyle = pal.fg; ctx.beginPath(); ctx.arc(pm[0], pm[1], 4 * D, 0, 6.28); ctx.fill(); ctx.stroke();
      h.tips.forEach((t, i) => { const q = P(t); ctx.fillStyle = i < 2 ? pal.ac : pal.fg; ctx.fillRect(q[0] - 3 * D, q[1] - 3 * D, 6 * D, 6 * D); });
      const pc = P(h.pinch);
      if (h.closed) { ctx.strokeStyle = pal.ac; ctx.lineWidth = 2 * D; ctx.beginPath(); ctx.arc(pc[0], pc[1], (9 + 4 * (m ? m.intensity : 0.5)) * D, 0, 6.28); ctx.stroke(); ctx.fillStyle = pal.ac; ctx.fillText('PINCH', pc[0] + 14 * D, pc[1] - 8 * D); }
      else if (h.open >= 1 && G.mode === 'windows') { ctx.fillStyle = pal.al; ctx.fillText('OPEN PALM · CLEAR', pm[0] - 40 * D, pm[1] + 26 * D); }
    }
  }
  const nrm = (a) => ({ x: a.w < 0 ? a.x + a.w : a.x, y: a.h < 0 ? a.y + a.h : a.y, w: Math.abs(a.w), h: Math.abs(a.h) });

  /* ---------- TouchDesigner looks ---------- */
  function mod(o, c) {
    const m = {}, src = o.macros || {}, re = o.reacts || {};
    for (const k of ['intensity', 'colour', 'chaos', 'trails', 'lines', 'size']) m[k] = cl((src[k] ?? 0.5) + env(c, re[k]) * 0.45);
    return m;
  }
  const TD = {};
  TD.plexus = (ctx, W, H, c, m, pal, st, o) => {
    const g = geo(W, H), D = st.D, src = o.src;
    const off = (st.body = st.body || document.createElement('canvas')); if (off.width !== W || off.height !== H) { off.width = W; off.height = H; }
    const oc = off.getContext('2d'); oc.globalCompositeOperation = 'source-over'; oc.clearRect(0, 0, W, H);
    fillSubject(oc, FIG, g, pal.fg, src);
    oc.globalCompositeOperation = 'source-atop';
    const n = 5 + Math.round(m.intensity * 18), seed = Math.floor(c.mt * 8);
    for (let i = 0; i < n; i++) {
      const y = H1(seed * 3 + i) * H, h = (2 + H1(i + seed) * 10 * m.intensity) * D;
      oc.fillStyle = i % 3 === 0 ? pal.bg : rgba(pal.ac, 0.55 + m.colour * 0.45); oc.fillRect(0, y, W, h);
    }
    for (let i = 0; i < 40 * m.intensity; i++) { oc.fillStyle = pal.bg; oc.fillRect(H1(i * 7 + seed) * W, H1(i * 3 + seed) * H, 3 * D, 2 * D); }
    oc.globalCompositeOperation = 'source-over';
    ctx.drawImage(off, 0, 0);
    if (!o.maskFirst && src !== 'stage') faceFeatures(ctx, FIG, g, pal.bg);
    const P = subjPts(FIG, src).map((p, i) => [g.X + (p[0] + Math.sin(c.mt * 2 + i) * 0.012 * m.chaos * 3) * g.S, g.Y + (p[1] + Math.cos(c.mt * 1.7 + i * 2) * 0.012 * m.chaos * 3) * g.S]);
    const extra = Math.round(m.chaos * 14);
    for (let i = 0; i < extra; i++) P.push([g.X + (H1(i * 9.1) - 0.5) * W * 0.9 + Math.sin(c.mt + i) * 20 * D, g.Y + H1(i * 4.3) * H * 0.9]);
    const L = (0.08 + m.lines * 0.34) * H;
    ctx.save(); ctx.shadowColor = pal.ac; ctx.shadowBlur = (4 + 14 * m.intensity) * D;
    for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) {
      const dx = P[i][0] - P[j][0], dy = P[i][1] - P[j][1], d = Math.hypot(dx, dy); if (d > L) continue;
      ctx.strokeStyle = rgba(m.colour > 0.25 ? pal.ac : pal.fg, (1 - d / L) * (0.5 + 0.5 * m.intensity)); ctx.lineWidth = (0.7 + m.lines * 1.6) * D;
      ctx.beginPath(); ctx.moveTo(P[i][0], P[i][1]); ctx.lineTo(P[j][0], P[j][1]); ctx.stroke();
    }
    ctx.restore();
    const sz = (3 + c.kick * 5 + m.size * 4) * D, lab = W > 300;
    ctx.font = `700 ${11 * D}px 'JetBrains Mono',monospace`;
    P.forEach((p, i) => {
      ctx.strokeStyle = pal.fg; ctx.lineWidth = 1 * D; ctx.fillStyle = i % 4 === 0 ? pal.ac : pal.bg;
      ctx.fillRect(p[0] - sz / 2, p[1] - sz / 2, sz, sz); ctx.strokeRect(p[0] - sz / 2, p[1] - sz / 2, sz, sz);
      if (lab && i % 2 === 0) { ctx.fillStyle = i % 4 === 0 ? pal.al : pal.fg; ctx.fillText(String(i).padStart(2, '0') + '·' + Math.round(p[0] / D), p[0] + sz, p[1] - sz); }
    });
    if (c.drop > 0.05) { const gr = ctx.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H * 0.45, H * 0.8); gr.addColorStop(0, rgba(pal.ac, 0.45 * c.drop * (0.4 + m.intensity))); gr.addColorStop(1, rgba(pal.ac, 0)); ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H); ctx.restore(); }
  };
  TD.mosaic = (ctx, W, H, c, m, pal, st, o) => {
    const D = st.D, cell = Math.max(8 * D, (0.032 + m.size * 0.05) * H), cols = Math.ceil(W / cell), rows = Math.ceil(H / cell);
    const mk = maskFor(W, H, cols, rows, o.src);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const v = mk.at(x, y); if (v < 0.4) continue;
      const h = H1(x * 31 + y * 17), pop = h < m.intensity * 0.45 ? c.kick * 0.7 : 0, sc = 0.86 + pop;
      const jx = (H1(h * 9) - 0.5) * m.chaos * cell * 1.6 * (1 + c.snare), jy = (H1(h * 5) - 0.5) * m.chaos * cell * 1.6;
      const w = cell * sc, px = x * cell + (cell - w) / 2 + jx, py = y * cell + (cell - w * 0.8) / 2 + jy, hh = w * 0.8;
      ctx.fillStyle = h > 0.5 ? pal.fg : mixHex(pal.fg, pal.bg, 0.45); ctx.fillRect(px, py, w, hh);
      const tb = Math.max(2 * D, hh * 0.2); ctx.fillStyle = h < m.colour ? pal.ac : '#1b1b1e'; ctx.fillRect(px, py, w, tb);
      if (w > 14 * D) { ctx.fillStyle = pal.fg; for (let k = 0; k < 3; k++) ctx.fillRect(px + w - (k + 1) * tb * 0.9, py + tb * 0.25, tb * 0.5, tb * 0.5); }
      if (h > 0.75) { ctx.fillStyle = rgba(pal.bg, 0.6); for (let k = 1; k < 4; k++) ctx.fillRect(px + w * 0.12, py + tb + k * (hh - tb) / 4.5, w * (0.4 + 0.4 * H1(k + h)), Math.max(1, D)); }
      ctx.strokeStyle = pal.bg; ctx.lineWidth = D; ctx.strokeRect(px, py, w, hh);
    }
    const big = Math.round(1 + m.intensity * 3 + c.kick * 2);
    ctx.font = `700 ${11 * D}px 'JetBrains Mono',monospace`;
    for (let k = 0; k < big; k++) {
      const h = H1(k * 13 + Math.floor(c.beats)), w = cell * (3 + h * 3), hh = w * 0.65;
      const px = W / 2 + (H1(k * 4 + Math.floor(c.beats)) - 0.5) * H * 0.55 - w / 2, py = H * (0.2 + H1(k * 8 + Math.floor(c.beats)) * 0.6);
      ctx.fillStyle = '#111113'; ctx.fillRect(px, py, w, hh); ctx.fillStyle = k % 2 ? pal.ac : pal.al; ctx.fillRect(px, py, w, 14 * D);
      ctx.fillStyle = '#0b0b0c'; if (w > 110 * D) ctx.fillText('SIGNAL_' + String(k + 1).padStart(2, '0'), px + 5 * D, py + 11 * D);
      ctx.fillStyle = pal.fg; for (let i = 0; i < 5; i++) ctx.fillRect(px + 6 * D, py + 20 * D + i * 7 * D, (w - 12 * D) * H1(i + k + h), 2 * D);
      ctx.strokeStyle = pal.fg; ctx.lineWidth = D; ctx.strokeRect(px, py, w, hh);
    }
  };
  TD.databody = (ctx, W, H, c, m, pal, st, o) => {
    const D = st.D, cell = Math.max(9 * D, (0.02 + m.size * 0.03) * H), cols = Math.ceil(W / cell), rows = Math.ceil(H / cell), mk = maskFor(W, H, cols, rows, o.src);
    const G = '01ABCDEF#%7X'; ctx.font = `700 ${cell * 0.95}px 'JetBrains Mono',monospace`; ctx.textBaseline = 'top';
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const v = mk.at(x, y), h = H1(x * 7 + y * 3); const fall = fr(c.mt * 0.6 + H1(x) * 3) * rows;
      if (v < 0.3) { if (h < 0.05 * m.intensity) { ctx.fillStyle = rgba(pal.fg, 0.18); ctx.fillText(G[(x + y) % G.length], x * cell, y * cell); } continue; }
      const edge = mk.at(x - 1, y) < 0.3 || mk.at(x + 1, y) < 0.3 || mk.at(x, y - 1) < 0.3;
      const head = Math.abs(y - fall) < 2;
      ctx.fillStyle = edge || head ? (m.colour > 0.2 ? pal.ac : pal.fg) : rgba(pal.fg, 0.45 + 0.5 * m.intensity * (0.5 + c.kick * 0.5));
      const jx = (H1(h + Math.floor(c.mt * 10)) - 0.5) * m.chaos * cell;
      ctx.fillText(G[Math.floor(H1(h * 11 + Math.floor(c.mt * 6 + h * 10)) * G.length)], x * cell + jx, y * cell);
    }
    ctx.textBaseline = 'alphabetic';
  };
  TD.trails = (ctx, W, H, c, m, pal, st, o) => {
    const g = geo(W, H), D = st.D;
    ctx.save(); ctx.shadowColor = pal.ac; ctx.shadowBlur = (8 + 24 * m.intensity) * D;
    const n = 1 + Math.round(m.chaos * 3);
    for (let k = 0; k < n; k++) { const gg = { ...g, X: g.X + (k - (n - 1) / 2) * 14 * D * m.chaos * (1 + c.snare) }; outlineSubject(ctx, FIG, gg, k === 0 ? pal.fg : rgba(pal.ac, 0.7), (1 + m.lines * 4) * D, o.src, pal.bg); }
    ctx.restore();
    ctx.fillStyle = pal.al;
    for (const p of [FIG.hL, FIG.hR]) for (let k = 0; k < 6; k++) { const a = c.mt * 3 + k; ctx.fillRect(g.X + p[0] * g.S + Math.cos(a) * 18 * D * (1 + c.kick), g.Y + p[1] * g.S + Math.sin(a) * 18 * D, 3 * D, 3 * D); }
  };
  TD.slitscan = (ctx, W, H, c, m, pal, st, o) => {
    const N = 24, w = Math.max(2, Math.round(W / 3)), h = Math.max(2, Math.round(H / 3));
    st.ring = st.ring || []; st.ri = (st.ri || 0) + 1;
    let f = st.ring[st.ri % N]; if (!f || f.width !== w || f.height !== h) { f = document.createElement('canvas'); f.width = w; f.height = h; st.ring[st.ri % N] = f; }
    const fc = f.getContext('2d'); fc.setTransform(1, 0, 0, 1, 0, 0); fc.clearRect(0, 0, w, h); fc.setTransform(w / W, 0, 0, h / H, 0, 0);
    fillSubject(fc, FIG, geo(W, H), (st.ri >> 2) % 2 ? pal.fg : pal.ac, o.src);
    const B = 10 + Math.round(m.lines * 30), span = 0.25 + m.chaos * 0.75;
    for (let k = 0; k < B; k++) {
      const d = Math.round((k / B) * (N - 1) * span * (0.6 + 0.4 * Math.sin(c.mt + k * 0.2))), fi = st.ring[(st.ri - d + N * 4) % N]; if (!fi) continue;
      const y0 = (k / B) * h, hh = h / B + 0.5;
      ctx.drawImage(fi, 0, y0, w, hh, 0, (k / B) * H, W, H / B + 1);
    }
  };
  TD.pointcloud = (ctx, W, H, c, m, pal, st, o) => {
    const D = st.D, step = Math.max(5 * D, (0.016 + m.size * 0.018) * H), cols = Math.ceil(W / step), rows = Math.ceil(H / step), mk = maskFor(W, H, cols, rows, o.src);
    const ang = Math.sin(c.mt * 0.5) * (0.3 + m.chaos * 0.9), ca = Math.cos(ang), sa = Math.sin(ang);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      if (mk.at(x, y) < 0.5) continue;
      const px = x * step - W / 2, z = Math.sqrt(Math.max(0, 1 - Math.pow(px / (H * 0.32), 2))) * H * 0.2;
      const rx = px * ca - z * sa, rz = px * sa + z * ca, p = 1 + rz / (H * 1.4);
      const r = (0.8 + m.size * 1.6) * D * p * (1 + c.kick * 0.6) + c.bass * D;
      ctx.fillStyle = H1(x * 3 + y) < m.colour * 0.6 ? pal.ac : rgba(pal.fg, 0.5 + 0.5 * (rz / (H * 0.2) + 0.5) * m.intensity);
      ctx.fillRect(W / 2 + rx * p - r / 2, (y * step - H / 2) * p + H / 2 - r / 2, r, r);
    }
  };
  TD.tunnel = (ctx, W, H, c, m, pal, st, o) => {
    const g = geo(W, H), D = st.D, n = 4 + Math.round(m.lines * 8);
    for (let k = n - 1; k >= 0; k--) {
      const s = 1 - k * (0.08 + m.size * 0.06) + c.kick * 0.03, rot = (H1(k) - 0.5) * m.chaos * 0.4 * Math.sin(c.mt);
      ctx.save(); ctx.translate(W / 2, H / 2); ctx.rotate(rot); ctx.scale(s, s); ctx.translate(-W / 2, -H / 2);
      for (const flip of [1, -1]) { ctx.save(); if (flip < 0) { ctx.translate(W, 0); ctx.scale(-1, 1); ctx.globalAlpha = 0.6; } outlineSubject(ctx, FIG, { ...g, X: g.X - W * 0.18 }, k % 2 ? pal.ac : rgba(pal.fg, 1 - k / n), (1.5 + m.intensity * 3) * D / s, o.src); ctx.restore(); }
      ctx.restore();
    }
  };
  TD.ascii = (ctx, W, H, c, m, pal, st, o) => {
    const D = st.D, cell = Math.max(9 * D, (0.022 + m.size * 0.022) * H), cols = Math.ceil(W / cell), rows = Math.ceil(H / cell), mk = maskFor(W, H, cols * 2, rows * 2, o.src);
    const R = ' .:-=+*#%@'; ctx.font = `700 ${cell}px 'JetBrains Mono',monospace`; ctx.textBaseline = 'top';
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const v = (mk.at(x * 2, y * 2) + mk.at(x * 2 + 1, y * 2) + mk.at(x * 2, y * 2 + 1) + mk.at(x * 2 + 1, y * 2 + 1)) / 4;
      const l = cl(v * (0.55 + 0.45 * (1 - y / rows)) * (0.6 + m.intensity * 0.6) + (H1(x * 3 + y * 7 + Math.floor(c.mt * 8)) - 0.5) * m.chaos * 0.5 + c.kick * 0.15 * v);
      if (l < 0.08) continue;
      ctx.fillStyle = l > 0.8 && m.colour > 0.2 ? pal.ac : pal.fg; ctx.fillText(R[Math.min(9, Math.floor(l * 10))], x * cell, y * cell);
    }
    ctx.textBaseline = 'alphabetic';
  };
  TD.linescan = (ctx, W, H, c, m, pal, st, o) => {
    const D = st.D, n = 26 + Math.round(m.lines * 50), cols = 90, mk = maskFor(W, H, cols, n, o.src), amp = H * (0.03 + m.size * 0.06) * (0.6 + c.bass);
    for (let r = 0; r < n; r++) {
      const y = ((r + 0.5) / n) * H; ctx.beginPath();
      for (let x = 0; x <= cols; x++) { const v = mk.at(Math.min(cols - 1, x), r); const yy = y - v * amp - (H1(x + r * 91 + Math.floor(c.mt * 10)) - 0.5) * m.chaos * amp * 0.6 * v; x ? ctx.lineTo((x / cols) * W, yy) : ctx.moveTo(0, yy); }
      ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath(); ctx.fillStyle = pal.bg; ctx.fill();
      ctx.strokeStyle = r % 5 === 0 && m.colour > 0.2 ? pal.ac : rgba(pal.fg, 0.5 + 0.5 * m.intensity); ctx.lineWidth = (1 + c.kick) * D; ctx.stroke();
    }
  };
  TD.halftone = (ctx, W, H, c, m, pal, st, o) => {
    const D = st.D, cell = Math.max(6 * D, (0.018 + m.size * 0.03) * H), cols = Math.ceil(W / cell), rows = Math.ceil(H / cell), mk = maskFor(W, H, cols, rows, o.src);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const v = mk.at(x, y), bg = (H1(x * 5 + y * 9) < 0.06 * m.chaos) ? 0.3 : 0; const l = Math.max(v * (0.6 + 0.4 * (1 - y / rows)), bg); if (l < 0.05) continue;
      const r = cell * 0.55 * l * (0.75 + c.kick * 0.4 * m.intensity);
      ctx.fillStyle = (mk.at(x - 1, y) < 0.3 || mk.at(x + 1, y) < 0.3) && m.colour > 0.15 ? pal.ac : pal.fg;
      ctx.beginPath(); ctx.arc(x * cell + cell / 2 + (y % 2) * cell * 0.5, y * cell + cell / 2, r, 0, Math.PI * 2); ctx.fill();
    }
  };

  TD.fwindows = (ctx, W, H, c, m, pal, st, o) => {
    const g = geo(W, H), D = st.D, G = o.src === 'stage' ? null : gesture(c, 'windows');
    fillSubject(ctx, FIG, g, rgba(pal.fg, 0.92), o.src);
    if (!o.maskFirst && o.src !== 'stage') faceFeatures(ctx, FIG, g, pal.bg);
    const wins = (G ? G.wins : []).concat(st.uwins || []), looks = ['inv', 'ascii', 'halftone', 'pointcloud', 'databody'];
    ctx.font = `700 ${11 * D}px 'JetBrains Mono',monospace`;
    wins.forEach((w, i) => {
      const pop = (i % 2 ? c.kick : c.snare) * 0.05 * (0.5 + m.intensity);
      let ww = w.w * g.S * (1 + pop), hh = w.h * g.S * (1 + pop);
      const x = g.X + (w.x + w.w / 2) * g.S - ww / 2 + (H1(i + Math.floor(c.mt * 8)) - 0.5) * m.chaos * 12 * D, y = g.Y + (w.y + w.h / 2) * g.S - hh / 2;
      const look = looks[(w.j ?? i) % looks.length];
      ctx.save(); ctx.beginPath(); ctx.rect(x, y, ww, hh); ctx.clip();
      ctx.fillStyle = look === 'inv' ? pal.ac : pal.bg; ctx.fillRect(x, y, ww, hh);
      if (look === 'inv') fillSubject(ctx, FIG, g, pal.bg, o.src); else TD[look](ctx, W, H, c, { ...m, size: 0.25 }, pal, st, o);
      ctx.restore();
      const tb = (12 + m.size * 6) * D;
      ctx.fillStyle = i % 3 === 0 ? pal.ac : pal.fg; ctx.fillRect(x, y - tb, ww, tb);
      ctx.strokeStyle = pal.fg; ctx.lineWidth = (1 + m.lines * 2) * D; ctx.strokeRect(x, y - tb, ww, hh + tb);
      ctx.fillStyle = pal.bg; if (ww > 90 * D) ctx.fillText('WIN_' + String(i + 1).padStart(2, '0'), x + 5 * D, y - tb / 2 + 4 * D);
      for (let k = 0; k < 3; k++) ctx.fillRect(x + ww - (k + 1) * tb * 0.8, y - tb * 0.72, tb * 0.45, tb * 0.45);
    });
    for (const a0 of [G && G.active, st.udrag]) {
      if (!a0) continue; const a = nrm(a0), x = g.X + a.x * g.S, y = g.Y + a.y * g.S, w = a.w * g.S, h = a.h * g.S;
      ctx.setLineDash([6 * D, 4 * D]); ctx.strokeStyle = pal.ac; ctx.lineWidth = 2 * D; ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
      ctx.fillStyle = pal.ac; ctx.fillText(`${Math.round(w / D)}×${Math.round(h / D)}`, x + w + 6 * D, y + h + 14 * D);
    }
    if (G && o.showHands !== false) drawHands(ctx, G, g, pal, D, m);
  };
  TD.strings = (ctx, W, H, c, m, pal, st, o) => {
    const g = geo(W, H), D = st.D, G = o.src === 'stage' ? null : gesture(c, 'strings');
    fillSubject(ctx, FIG, g, mixHex(pal.bg, pal.fg, 0.16 + 0.1 * c.bass), o.src);
    if (!o.maskFirst && o.src !== 'stage') faceFeatures(ctx, FIG, g, pal.bg);
    if (!G) return;
    const P = (t) => [g.X + t[0] * g.S, g.Y + t[1] * g.S];
    ctx.save(); ctx.shadowColor = pal.ac; ctx.shadowBlur = (6 + 16 * m.intensity) * D; ctx.globalCompositeOperation = 'lighter';
    G.L.tips.forEach((a, i) => G.R.tips.forEach((b, j) => {
      if (m.lines < 0.5 && i !== 4 - j) return;
      const A = P(a), B = P(b), amp = (c.kick * 16 + m.chaos * 10) * D * Math.sin(c.mt * 30 + i * 1.7 + j);
      ctx.strokeStyle = rgba((i + j) % 2 ? pal.ac : pal.fg, 0.45 + 0.45 * m.intensity); ctx.lineWidth = (0.8 + m.lines * 1.8) * D;
      ctx.beginPath(); ctx.moveTo(A[0], A[1]); ctx.quadraticCurveTo((A[0] + B[0]) / 2, (A[1] + B[1]) / 2 + amp, B[0], B[1]); ctx.stroke();
    }));
    ctx.restore();
    ctx.font = `700 ${11 * D}px 'JetBrains Mono',monospace`; ctx.fillStyle = pal.al;
    if (W > 300) [...G.L.tips, ...G.R.tips].forEach((t, i) => { const q = P(t); ctx.fillText(String(i + 1).padStart(2, '0'), q[0] + 6 * D, q[1] - 6 * D); });
    if (o.showHands !== false) drawHands(ctx, G, g, pal, D, m);
  };
  TD.portal = (ctx, W, H, c, m, pal, st, o) => {
    const g = geo(W, H), D = st.D, G = o.src === 'stage' ? null : gesture(c, 'portal');
    fillSubject(ctx, FIG, g, pal.fg, o.src);
    if (!o.maskFirst && o.src !== 'stage') faceFeatures(ctx, FIG, g, pal.bg);
    for (const pt of [G && G.portal, st.uportal]) {
      if (!pt) continue;
      const x = g.X + pt.x * g.S, y = g.Y + pt.y * g.S, r = pt.r * g.S * (0.7 + m.size * 0.6) * (1 + c.kick * 0.06 * (0.5 + m.intensity));
      ctx.save(); ctx.beginPath(); ctx.arc(x, y, r, 0, 6.28); ctx.clip();
      ctx.fillStyle = pal.ac; ctx.fillRect(x - r, y - r, r * 2, r * 2); fillSubject(ctx, FIG, g, pal.bg, o.src);
      ctx.strokeStyle = rgba(pal.fg, 0.8); ctx.lineWidth = (1 + m.lines * 2) * D;
      for (let k = 0; k < 6; k++) { const f = fr(c.beats / 2 + k / 6); ctx.beginPath(); ctx.arc(x, y, r * f, 0, 6.28); ctx.stroke(); }
      ctx.restore();
      ctx.strokeStyle = pal.fg; ctx.lineWidth = 2 * D; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.28); ctx.stroke();
      ctx.font = `700 ${11 * D}px 'JetBrains Mono',monospace`; ctx.fillStyle = pal.al; ctx.fillText('PORTAL · R ' + Math.round(r / D), x - r, y - r - 8 * D);
    }
    if (G && o.showHands !== false) drawHands(ctx, G, g, pal, D, m);
  };

  function drawTD(ctx, W, H, c, o, st) {
    const pal = PAL[o.palette] || PAL.ember, m = mod(o, c), fn = TD[o.fx] || TD.plexus;
    const tr = o.fx === 'trails' ? Math.max(0.55, m.trails) : m.trails;
    ctx.globalAlpha = 1 - tr * 0.88; ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, W, H); ctx.globalAlpha = 1;
    if (o.idle) ctx.globalAlpha = 0.85;
    const hm = HANDS_FX[o.fx], saved = FIG;
    if (hm && o.src !== 'stage') FIG = figWithHands(gesture(c, hm));
    try { fn(ctx, W, H, c, m, pal, st, o); ctx.globalAlpha = 1; if (o.maskFirst && o.src !== 'stage') lowpoly(ctx, FIG, geo(W, H), pal, c, 'lowpoly'); }
    finally { FIG = saved; }
  }

  /* ---------- VISUALS stack ---------- */
  const GEN = {}, FIL = {};
  GEN.rings = (ctx, W, H, c, pal, D, p) => { ctx.lineWidth = 2 * D; for (let k = 0; k < 6; k++) { const f = fr(c.beats / 2 + k / 6), r = f * Math.hypot(W, H) * 0.55; ctx.strokeStyle = rgba(k % 2 ? pal.ac : pal.fg, (1 - f) * 0.8); ctx.beginPath(); ctx.arc(W / 2, H / 2, r, 0, Math.PI * 2); ctx.stroke(); } };
  GEN.bars = (ctx, W, H, c, pal, D, p) => { const n = 32, w = W / n; for (let i = 0; i < n; i++) { const h = H * 0.5 * (0.15 + 0.85 * H1(i + Math.floor(c.mt * 10)) * (0.3 + c.bass * 0.4 + c.kick * 0.5 * (i < 8))); ctx.fillStyle = i % 4 ? rgba(pal.fg, 0.7) : pal.ac; ctx.fillRect(i * w + 1, H - h, w - 2, h); } };
  GEN.stars = (ctx, W, H, c, pal, D, p) => { for (let i = 0; i < 140; i++) { const a = H1(i) * 6.28, z = fr(H1(i * 3) + c.mt * (0.08 + c.energy * 0.25)), r = z * z * Math.hypot(W, H) * 0.6; ctx.fillStyle = rgba(pal.fg, z); const s = (1 + z * 3) * D; ctx.fillRect(W / 2 + Math.cos(a) * r, H / 2 + Math.sin(a) * r, s, s); } };
  GEN.grid = (ctx, W, H, c, pal, D, p) => { ctx.strokeStyle = rgba(pal.ac, 0.8); ctx.lineWidth = 1.5 * D; const hz = H * 0.55; for (let i = 0; i < 14; i++) { const f = fr(i / 14 + c.mt * 0.3), y = hz + (H - hz) * f * f; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); } for (let i = -10; i <= 10; i++) { ctx.beginPath(); ctx.moveTo(W / 2 + i * W * 0.02, hz); ctx.lineTo(W / 2 + i * W * 0.2, H); ctx.stroke(); } };
  GEN.blocks = (ctx, W, H, c, pal, D, p) => { const n = Math.round(4 + c.snare * 18); for (let i = 0; i < n; i++) { const s = Math.floor(c.mt * 8); ctx.fillStyle = i % 3 ? rgba(pal.ac, 0.8) : rgba('#7cc8ff', 0.7); ctx.fillRect(H1(i + s) * W, H1(i * 2 + s) * H, W * 0.04 + H1(i * 5) * W * 0.2, H * 0.01 + H1(i * 7) * H * 0.05); } };
  GEN.scope = (ctx, W, H, c, pal, D, p) => { ctx.strokeStyle = pal.fg; ctx.lineWidth = 2 * D; ctx.shadowColor = pal.ac; ctx.shadowBlur = 10 * D; ctx.beginPath(); for (let x = 0; x <= W; x += 3 * D) { const u = x / W, y = H / 2 + Math.sin(u * 30 + c.mt * 6) * H * 0.12 * (0.3 + c.bass) * Math.sin(u * Math.PI) + Math.sin(u * 90 + c.mt * 11) * H * 0.03 * c.snare; x ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } ctx.stroke(); ctx.shadowBlur = 0; };
  GEN.tunnel = (ctx, W, H, c, pal, D, p) => { ctx.lineWidth = 2 * D; for (let k = 0; k < 10; k++) { const f = fr(k / 10 + c.mt * 0.25), s = f * f * Math.max(W, H); ctx.save(); ctx.translate(W / 2, H / 2); ctx.rotate(f * 1.2 + c.mt * 0.2); ctx.strokeStyle = rgba(k % 2 ? pal.ac : pal.fg, f); ctx.strokeRect(-s / 2, -s / 2, s, s); ctx.restore(); } };
  GEN.blobs = (ctx, W, H, c, pal, D, p) => { for (let k = 0; k < 4; k++) { const x = W * (0.5 + 0.35 * Math.sin(c.mt * (0.3 + k * 0.17) + k + p)), y = H * (0.5 + 0.3 * Math.cos(c.mt * (0.25 + k * 0.13) + k * 2)), r = H * (0.25 + 0.15 * c.bass); const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, rgba(k % 2 ? pal.ac : pal.al, 0.6)); g.addColorStop(1, rgba(pal.ac, 0)); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); } };
  GEN.radial = (ctx, W, H, c, pal, D, p) => { ctx.strokeStyle = rgba(pal.fg, 0.6); ctx.lineWidth = 1.5 * D; for (let i = 0; i < 48; i++) { const a = (i / 48) * 6.28 + c.mt * 0.3, r0 = H * 0.18, r1 = r0 + H * 0.25 * (0.3 + H1(i + Math.floor(c.beats * 2)) * c.kick); ctx.beginPath(); ctx.moveTo(W / 2 + Math.cos(a) * r0, H / 2 + Math.sin(a) * r0); ctx.lineTo(W / 2 + Math.cos(a) * r1, H / 2 + Math.sin(a) * r1); ctx.stroke(); } };
  GEN.vortex = (ctx, W, H, c, pal, D, p) => { ctx.strokeStyle = rgba(pal.ac, 0.8); ctx.lineWidth = 1.5 * D; for (let arm = 0; arm < 4; arm++) { ctx.beginPath(); for (let i = 0; i < 80; i++) { const a = i * 0.12 + arm * 1.57 + c.mt * 0.8, r = i * H * 0.007; i ? ctx.lineTo(W / 2 + Math.cos(a) * r, H / 2 + Math.sin(a) * r) : ctx.moveTo(W / 2, H / 2); } ctx.stroke(); } };
  GEN.hex = (ctx, W, H, c, pal, D, p) => { const s = H * 0.07; ctx.lineWidth = 1.2 * D; for (let y = 0; y < H / (s * 1.5) + 1; y++) for (let x = 0; x < W / (s * 1.73) + 1; x++) { const cx = x * s * 1.73 + (y % 2) * s * 0.866, cy = y * s * 1.5, d = Math.hypot(cx - W / 2, cy - H / 2) / H; ctx.strokeStyle = rgba(pal.ac, cl(0.15 + c.kick * (1 - fr(d * 2 - c.ph)) * 0.8)); ctx.beginPath(); for (let k = 0; k < 6; k++) { const a = k * 1.047 + 0.52; ctx.lineTo(cx + Math.cos(a) * s * 0.9, cy + Math.sin(a) * s * 0.9); } ctx.closePath(); ctx.stroke(); } };
  GEN.flash = (ctx, W, H, c, pal, D, p, st) => { if (c.drop > 0.9 && st.fb !== Math.floor(c.beats) && canFlash()) { st.fb = Math.floor(c.beats); st.fl = 1; } st.fl = (st.fl || 0) * 0.82; if (st.fl > 0.02) { ctx.fillStyle = rgba(pal.fg, st.fl * 0.55); ctx.fillRect(0, 0, W, H); } };
  GEN.core = (ctx, W, H, c, pal, D, p) => { const r = H * (0.12 + c.voice * 0.05 + c.kick * 0.04); const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, r * 2.4); g.addColorStop(0, rgba(pal.fg, 0.9)); g.addColorStop(0.35, rgba(pal.ac, 0.7)); g.addColorStop(1, rgba(pal.ac, 0)); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); };
  GEN.kaleido = (ctx, W, H, c, pal, D, p) => { ctx.save(); ctx.translate(W / 2, H / 2); for (let k = 0; k < 8; k++) { ctx.rotate(Math.PI / 4); ctx.fillStyle = rgba(k % 2 ? pal.ac : pal.al, 0.35); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(H * 0.5, H * 0.08 * Math.sin(c.mt + k)); ctx.lineTo(H * 0.45 * (0.6 + c.kick * 0.4), H * 0.2); ctx.closePath(); ctx.fill(); } ctx.restore(); };
  GEN.milk = (ctx, W, H, c, pal, D, p, st) => {
    if (!st.prev || st.prev.width !== W || st.prev.height !== H) { st.prev = document.createElement('canvas'); st.prev.width = W; st.prev.height = H; }
    ctx.save(); ctx.globalAlpha = 0.86; ctx.translate(W / 2, H / 2); ctx.rotate(0.02 + p * 0.01); ctx.scale(1.025 + c.bass * 0.02, 1.025); ctx.translate(-W / 2, -H / 2); ctx.drawImage(st.prev, 0, 0); ctx.restore();
    const hue = (p * 67 + c.mt * 20) % 360; ctx.strokeStyle = `hsla(${hue},90%,60%,0.9)`; ctx.lineWidth = 3 * D; ctx.beginPath();
    for (let i = 0; i <= 60; i++) { const a = (i / 60) * 6.28, r = H * (0.15 + 0.08 * Math.sin(a * (3 + (p % 4)) + c.mt * 2) * (0.4 + c.kick)); i ? ctx.lineTo(W / 2 + Math.cos(a) * r, H / 2 + Math.sin(a) * r) : ctx.moveTo(W / 2 + r, H / 2); }
    ctx.stroke(); const pc = st.prev.getContext('2d'); pc.globalCompositeOperation = 'copy'; pc.drawImage(ctx.canvas, 0, 0, W, H); pc.globalCompositeOperation = 'source-over';
  };
  let scratch = document.createElement('canvas');
  const snap = (ctx, W, H) => { if (scratch.width !== W || scratch.height !== H) { scratch.width = W; scratch.height = H; } const s = scratch.getContext('2d'); s.globalCompositeOperation = 'copy'; s.drawImage(ctx.canvas, 0, 0); s.globalCompositeOperation = 'source-over'; return scratch; };
  FIL.rgb = (ctx, W, H, c, pal, D) => { const s = snap(ctx, W, H), d = (4 + c.kick * 14) * D; ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha *= 0.45; ctx.drawImage(s, d, 0); ctx.drawImage(s, -d, 0); ctx.globalCompositeOperation = 'color'; ctx.fillStyle = rgba(pal.ac, 0.25); ctx.fillRect(0, 0, d * 6, H); };
  FIL.vhs = (ctx, W, H, c, pal, D) => { const s = snap(ctx, W, H); for (let i = 0; i < 6; i++) { const y = H1(i + Math.floor(c.mt * 6)) * H, h = H * 0.03; ctx.drawImage(s, 0, y, W, h, (H1(i * 3) - 0.5) * 40 * D * (0.3 + c.snare), y, W, h); } ctx.fillStyle = 'rgba(0,0,0,.35)'; for (let y = 0; y < H; y += 3 * D) ctx.fillRect(0, y, W, D); };
  FIL.halftone = (ctx, W, H, c, pal, D) => { const s = H * 0.022; ctx.fillStyle = 'rgba(0,0,0,.55)'; for (let y = 0; y < H; y += s) for (let x = 0; x < W; x += s) { ctx.beginPath(); ctx.arc(x, y, s * 0.32 * (1 - c.kick * 0.4), 0, 6.28); ctx.fill(); } };
  FIL.zoom = (ctx, W, H, c, pal, D) => { const s = snap(ctx, W, H), k = 1 + 0.07 * c.kick; ctx.globalAlpha *= 0.6; ctx.drawImage(s, (W - W * k) / 2, (H - H * k) / 2, W * k, H * k); };
  FIL.feedback = (ctx, W, H, c, pal, D, st) => { if (st.prev && st.prev.width === W) { ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha *= 0.4; ctx.drawImage(st.prev, -W * 0.01, -H * 0.01, W * 1.02, H * 1.02); } if (!st.prev || st.prev.width !== W || st.prev.height !== H) { st.prev = document.createElement('canvas'); st.prev.width = W; st.prev.height = H; } const pc = st.prev.getContext('2d'); pc.globalCompositeOperation = 'copy'; pc.drawImage(ctx.canvas, 0, 0); };
  FIL.edge = (ctx, W, H, c, pal, D) => { ctx.shadowColor = pal.ac; ctx.shadowBlur = 16 * D; outlineSubject(ctx, FIG, geo(W, H), pal.ac, (2 + c.bass * 3) * D); ctx.shadowBlur = 0; };
  FIL.thermal = (ctx, W, H, c, pal, D) => { ctx.globalCompositeOperation = 'color'; const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#ffe45c'); g.addColorStop(0.5, '#ff4b2b'); g.addColorStop(1, '#3a1cff'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); };
  FIL.mirror = (ctx, W, H, c, pal, D) => { const s = snap(ctx, W, H); ctx.save(); ctx.translate(W, 0); ctx.scale(-1, 1); ctx.drawImage(s, 0, 0, W / 2, H, 0, 0, W / 2, H); ctx.restore(); };
  FIL.sort = (ctx, W, H, c, pal, D) => { const s = snap(ctx, W, H); for (let i = 0; i < 40; i++) { const x = H1(i + Math.floor(c.mt * 4)) * W, y = H1(i * 2) * H * 0.6; ctx.drawImage(s, x, y, 2 * D, 1, x, y, 2 * D, H * 0.3 * (0.4 + c.bass)); } };
  FIL.strobe = (ctx, W, H, c, pal, D, st) => { if (c.kick > 0.95 && st.sb !== Math.floor(c.beats) && canFlash()) { st.sb = Math.floor(c.beats); st.sl = 1; } st.sl = (st.sl || 0) * 0.7; if (st.sl > 0.02) { ctx.fillStyle = rgba(pal.fg, st.sl * 0.3); ctx.fillRect(0, 0, W, H); } };
  FIL.mosh = (ctx, W, H, c, pal, D) => { const s = snap(ctx, W, H); for (let i = 0; i < 10; i++) { const k = Math.floor(c.mt * 5), w = W * 0.1, h = H * 0.08, x = H1(i + k) * W, y = H1(i * 4 + k) * H; ctx.drawImage(s, x, y, w, h, x + (H1(i * 9) - 0.5) * w * c.snare * 2, y + h * 0.3, w, h); } };
  FIL.wobble = (ctx, W, H, c, pal, D) => { const s = snap(ctx, W, H), n = 24; for (let i = 0; i < n; i++) { const y = (i / n) * H; ctx.drawImage(s, 0, y, W, H / n + 1, Math.sin(i * 0.5 + c.mt * 6) * 12 * D * c.bass, y, W, H / n + 1); } };
  FIL.focus = (ctx, W, H, c, pal, D) => { const s = snap(ctx, W, H); ctx.filter = `blur(${4 * D}px)`; ctx.globalAlpha *= 0.7; ctx.drawImage(s, 0, 0); ctx.filter = 'none'; };
  FIL.palette = (ctx, W, H, c, pal, D) => { ctx.globalCompositeOperation = 'hue'; ctx.fillStyle = `hsl(${(c.mt * 15) % 360},80%,50%)`; ctx.fillRect(0, 0, W, H); };

  function drawText(ctx, W, H, c, t, pal, D) {
    const word = (t.word || 'GHOSTWIRE').toUpperCase(), sz = Math.min(W / (word.length * 0.6), H * 0.22);
    ctx.font = `800 ${sz}px 'Big Shoulders Display',sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    let s = word;
    if (t.mode === 'decrypt') { const p = fr(c.beats / 8); s = word.split('').map((ch, i) => (i / word.length < p * 1.4 ? ch : '#%01X7'[Math.floor(H1(i + Math.floor(c.mt * 15)) * 6)])).join(''); }
    if (t.mode === 'countdown') s = String(Math.max(1, Math.ceil(c.toNextBars))).padStart(2, '0');
    const k = t.mode === 'slam' ? 1 + c.drop * 0.25 + c.kick * 0.05 : 1;
    ctx.save(); ctx.translate(W / 2, H * 0.78); ctx.scale(k, k);
    if (t.mode === 'shatter' && c.kick > 0.2) { for (let i = 0; i < 6; i++) { ctx.save(); ctx.beginPath(); ctx.rect(-W, -sz / 2 + (i * sz) / 6, W * 2, sz / 6); ctx.clip(); ctx.fillStyle = i % 2 ? pal.fg : pal.ac; ctx.fillText(s, (H1(i + Math.floor(c.beats)) - 0.5) * 40 * D * c.kick, 0); ctx.restore(); } }
    else { ctx.fillStyle = pal.fg; ctx.fillText(s, 0, 0); ctx.fillStyle = rgba(pal.ac, 0.6); ctx.fillText(s, 3 * D, 2 * D); }
    ctx.restore(); ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic';
  }
  function drawBase(ctx, W, H, c, b, pal, D, st) {
    ctx.fillStyle = '#070708'; ctx.fillRect(0, 0, W, H);
    const k = b?.kind || 'none';
    if (k === 'camera') {
      const g = geo(W, H), gr = ctx.createLinearGradient(0, H * 0.2, 0, H); gr.addColorStop(0, '#4a4844'); gr.addColorStop(1, '#17171a');
      const bgG = ctx.createRadialGradient(W * 0.3, H * 0.2, 0, W * 0.3, H * 0.2, H); bgG.addColorStop(0, '#1d1c20'); bgG.addColorStop(1, '#09090a'); ctx.fillStyle = bgG; ctx.fillRect(0, 0, W, H);
      fillSubject(ctx, FIG, g, gr); ctx.save(); ctx.shadowColor = pal.ac; ctx.shadowBlur = 12 * D; ctx.globalAlpha = 0.5; outlineSubject(ctx, FIG, { ...g, X: g.X + 3 * D }, rgba(pal.ac, 0.6), 2 * D); ctx.restore();
      ctx.fillStyle = 'rgba(255,255,255,.025)'; for (let y = 0; y < H; y += 3 * D) ctx.fillRect(0, y, W, D);
    } else if (k === 'waveform') { ctx.fillStyle = rgba(pal.fg, 0.75); const n = 90; for (let i = 0; i < n; i++) { const h = H * 0.35 * (0.2 + 0.8 * H1(i * 3 + Math.floor(c.beats * 2))) * (0.3 + c.bass * 0.5 + c.kick * 0.4) * Math.sin((i / n) * Math.PI); ctx.fillRect((i / n) * W, H / 2 - h, W / n - D, h * 2); } }
    else if (k === 'core') GEN.core(ctx, W, H, c, pal, D, 0);
    else if (k === 'td') drawTD(ctx, W, H, c, { ...(b.td || {}), src: 'cam', maskFirst: false }, st);
    else if (k === 'photo' || k === 'video') { const gr = ctx.createLinearGradient(0, 0, W, H); gr.addColorStop(0, '#2a1410'); gr.addColorStop(1, '#0b0f16'); ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H); }
  }
  const LAYER = { // fx id -> [fn, isFilter, param]
    'beat-rings': ['rings'], 'spectrum-bars': ['bars'], starfield: ['stars'], 'synth-grid': ['grid'], 'glitch-blocks': ['blocks'], scope: ['scope'], tunnel: ['tunnel'], plasma: ['blobs', 0, 0], metaballs: ['blobs', 0, 2], fog: ['blobs', 0, 4], 'radial-ring': ['radial'], vortex: ['vortex'], 'hex-lattice': ['hex'], 'drop-flash': ['flash'], 'voice-core': ['core'], kaleido: ['kaleido'],
    'rgb-split': ['rgb', 1], vhs: ['vhs', 1], halftone: ['halftone', 1], 'zoom-pulse': ['zoom', 1], 'feedback-trails': ['feedback', 1], 'motion-trails': ['feedback', 1], 'edge-glow': ['edge', 1], thermal: ['thermal', 1], 'kaleido-mirror': ['mirror', 1], 'pixel-sort': ['sort', 1], 'beat-strobe': ['strobe', 1], datamosh: ['mosh', 1], 'bass-wobble': ['wobble', 1], 'depth-focus': ['focus', 1], 'palette-from-image': ['palette', 1],
  };
  function drawLayer(ctx, W, H, c, L, pal, D, st) {
    if (L.cat === 'milk') return GEN.milk(ctx, W, H, c, pal, D, L.seed || 1, st);
    if (L.cat === 'td') { ctx.save(); ctx.globalCompositeOperation = 'screen'; const s2 = (st.tdc = st.tdc || {}); const off = (st.tdo = st.tdo || document.createElement('canvas')); if (off.width !== W || off.height !== H) { off.width = W; off.height = H; } const oc = off.getContext('2d'); s2.D = D; drawTD(oc, W, H, c, { ...(L.td || {}), src: 'cam' }, s2); ctx.drawImage(off, 0, 0); ctx.restore(); return; }
    if (L.cat === 'text') return drawText(ctx, W, H, c, L, pal, D);
    const def = LAYER[L.fx] || ['rings'];
    ctx.save();
    if (def[1]) FIL[def[0]](ctx, W, H, c, pal, D, st); else { ctx.globalCompositeOperation = L.blend === 'normal' ? 'source-over' : 'lighter'; GEN[def[0]](ctx, W, H, c, pal, D, def[2] || 0, st); }
    ctx.restore();
  }
  function drawStack(ctx, W, H, c, o, st) {
    const pal = PAL[o.palette] || PAL.ember, D = st.D;
    drawBase(ctx, W, H, c, o.base, pal, D, st);
    const layers = (o.layers || []).slice().reverse();
    const solo = layers.some((l) => l.solo);
    st.ls = st.ls || {};
    for (const L of layers) {
      if (L.mute || (solo && !L.solo)) continue;
      const ls = (st.ls[L.id] = st.ls[L.id] || { D });
      ctx.save(); ctx.globalAlpha = (L.op ?? 1) * (L.reacts && L.reacts !== 'none' ? 0.3 + 0.7 * env(c, L.reacts) : 1);
      drawLayer(ctx, W, H, c, L, pal, D, ls); ctx.restore();
    }
    if (o.preview) { ctx.save(); ctx.globalAlpha = 0.9; drawLayer(ctx, W, H, c, o.preview, pal, D, (st.pv = st.pv || { D })); ctx.restore(); }
    if (o.text && o.text.on && !o.text.mute) { ctx.save(); ctx.globalAlpha = o.text.op ?? 1; drawText(ctx, W, H, c, o.text, pal, D); ctx.restore(); }
    if (o.dropFx) { st.dfx = (st.dfx || 0) + 1; if (st.dfx === 1 && canFlash()) st.dfl = 1; st.dfl = (st.dfl || 0) * 0.85; FIL.zoom(ctx, W, H, { ...c, kick: 1 }, pal, D); FIL.rgb(ctx, W, H, { ...c, kick: 1 }, pal, D); ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1; if (st.dfl > 0.02) { ctx.fillStyle = rgba(pal.fg, st.dfl * 0.4); ctx.fillRect(0, 0, W, H); } } else st.dfx = 0;
    if (o.face && o.face.on && o.base && (o.base.kind === 'camera' || o.base.kind === 'td')) lowpoly(ctx, FIG, geo(W, H), pal, c, o.face.style || 'lowpoly');
    if (o.blackout) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); }
  }
  function drawLayerThumb(ctx, W, H, c, o, st) {
    const pal = PAL[o.palette] || PAL.ember;
    const isFil = o.layer && (LAYER[o.layer.fx] || [])[1];
    drawBase(ctx, W, H, c, { kind: isFil || o.layer?.cat === 'face' ? 'camera' : 'none' }, pal, st.D, st);
    if (o.layer?.cat === 'face') return lowpoly(ctx, FIG, geo(W, H), pal, c, o.layer.style);
    if (o.layer?.cat === 'base') { drawBase(ctx, W, H, c, { kind: o.layer.kind, td: o.layer.td }, pal, st.D, st); if (o.layer.kind === 'camera' && o.faceOn) lowpoly(ctx, FIG, geo(W, H), pal, c, 'lowpoly'); return; }
    if (o.layer) drawLayer(ctx, W, H, c, o.layer, pal, st.D, st);
  }

  /* ---------- small instruments ---------- */
  const SRC_C = { hand: '#e79bd0', kick: '#ff4b2b', snare: '#ffb23e', bass: '#7cc8ff', drop: '#ff4b2b', section: '#e9e5da', voice: '#7fd08a', level: '#7fd08a' };
  function drawMeter(ctx, W, H, c, o, st) {
    ctx.clearRect(0, 0, W, H);
    const n = o.segs || 8, v = o.src === 'none' ? 0 : env(c, o.src), col = o.color || SRC_C[o.src] || '#e9e5da', g = Math.max(1, st.D * 1.5);
    st.pk = Math.max(v, (st.pk || 0) * 0.94);
    for (let i = 0; i < n; i++) {
      const on = i < Math.round(v * n), pk = i === Math.max(0, Math.round(st.pk * n) - 1);
      ctx.fillStyle = on ? (o.hot && i >= n - 2 ? '#ff4b2b' : col) : pk && st.pk > 0.05 ? rgba(col, 0.6) : 'rgba(233,229,218,.1)';
      if (o.vertical) { const h = (H - g * (n - 1)) / n; ctx.fillRect(0, H - (i + 1) * h - i * g, W, h); }
      else { const w = (W - g * (n - 1)) / n; ctx.fillRect(i * (w + g), 0, w, H); }
    }
  }
  function drawModring(ctx, W, H, c, o, st) {
    ctx.clearRect(0, 0, W, H);
    if (!o.src || o.src === 'none') return;
    const v = cl((o.v ?? 0.5) + env(c, o.src) * 0.45), r = Math.min(W, H) / 2 - 2 * st.D, a0 = Math.PI * 0.75, a1 = a0 + Math.PI * 1.5 * v;
    ctx.strokeStyle = SRC_C[o.src] || '#ffb23e'; ctx.lineWidth = 3 * st.D; ctx.lineCap = 'round';
    ctx.globalAlpha = 0.35 + 0.65 * env(c, o.src); ctx.beginPath(); ctx.arc(W / 2, H / 2, r, a0, a1); ctx.stroke(); ctx.globalAlpha = 1;
  }
  const SEC_C = { INTRO: '#9aa3b5', BUILD: '#d9c46a', DROP: '#ff4b2b', BREAK: '#6fc2b0' };
  function drawSections(ctx, W, H, c, o, st) {
    ctx.clearRect(0, 0, W, H); let acc = 0; const g = st.D;
    for (const [n, len] of PLAN) { const x = (acc / TOTAL) * W, w = (len / TOTAL) * W - g; ctx.fillStyle = rgba(SEC_C[n], c.playing ? (c.sec === n && c.bar >= acc && c.bar < acc + len ? 0.95 : 0.3) : 0.15); ctx.fillRect(x, 0, w, H); acc += len; }
    if (c.playing) { ctx.fillStyle = '#e9e5da'; ctx.fillRect((c.bar / TOTAL) * W - g, -1, 2 * g, H + 2); }
  }

  /* ---------- loop ---------- */
  const items = new Map();
  function attach(el, get) { if (!el) return; items.set(el, { get, st: {}, last: 0 }); }
  function frame(ts) {
    requestAnimationFrame(frame);
    const wall = ts / 1000; C = computeClock(wall); frameId++; masks = new Map(); GC = {}; FIG = figure(C); C.hand = gesture(C, 'windows').spread || 0;
    for (const [el, it] of items) {
      if (!el.isConnected) { items.delete(el); continue; }
      let o; try { o = it.get(); } catch (e) { continue; }
      if (!o) continue;
      const fps = o.fps || 60; if (wall - it.last < 1 / fps - 0.004) continue; it.last = wall;
      if (o.frozen && el.width > 2) continue;
      const D = Math.min(o.dpr || 2, window.devicePixelRatio || 1), w = Math.round(el.clientWidth * D), h = Math.round(el.clientHeight * D);
      if (!w || !h) continue;
      if (el.width !== w || el.height !== h) { el.width = w; el.height = h; }
      const ctx = el.getContext('2d'); it.st.D = D;
      ctx.save();
      try {
        if (o.kind === 'td') drawTD(ctx, w, h, C, o, it.st);
        else if (o.kind === 'stack') drawStack(ctx, w, h, C, o, it.st);
        else if (o.kind === 'layer') drawLayerThumb(ctx, w, h, C, o, it.st);
        else if (o.kind === 'meter') drawMeter(ctx, w, h, C, o, it.st);
        else if (o.kind === 'modring') drawModring(ctx, w, h, C, o, it.st);
        else if (o.kind === 'sections') drawSections(ctx, w, h, C, o, it.st);
      } catch (e) { if (!it.err) { it.err = 1; console.warn('fx', o.kind, e); } }
      ctx.restore();
    }
  }
  requestAnimationFrame(frame);
  function pointer(el, phase, nx, ny) {
    const it = items.get(el); if (!it) return; const st = it.st, W = el.width, H = el.height, g = geo(W, H), bx = (nx * W - g.X) / g.S, by = (ny * H - g.Y) / g.S;
    if (phase === 'down') st.udrag = { x0: bx, y0: by, x: bx, y: by, w: 0, h: 0 };
    else if (phase === 'move' && st.udrag) { const d = st.udrag; d.x = Math.min(d.x0, bx); d.y = Math.min(d.y0, by); d.w = Math.abs(bx - d.x0); d.h = Math.abs(by - d.y0); }
    else if (phase === 'up' && st.udrag) { const d = st.udrag; st.udrag = null; if (d.w > 0.03 && d.h > 0.03) { st.uwins = (st.uwins || []).concat([{ x: d.x, y: d.y, w: d.w, h: d.h, j: (st.uwins || []).length + 2 }]).slice(-6); return 'window'; } st.uportal = { x: bx, y: by, r: 0.12 }; return 'portal'; }
  }
  window.FXE = {
    attach, PAL, pointer,
    clearUser(el) { const it = items.get(el); if (it) { it.st.uwins = []; it.st.uportal = null; } },
    clock: () => C || computeClock(performance.now() / 1000),
    setPlaying(p) { M.playing = p; },
    restart() { M.start = performance.now() / 1000 - bl() * 4 * 12.5; },
    reduced: () => rm.matches,
  };
})();
