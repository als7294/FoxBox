/**
 * The FRAME's one extra pass (glass.ts says when, which and where): a WebGL2 canvas the stage's size, transparent
 * outside the hands' frame, drawn over the composite. It keeps the camera's last ~4.3 s on the GPU (RING: 128 frames
 * of 480 x 270, ~66 MB) as the stage feeds it (`record`, each new camera frame: with FACE HIDING, the hidden picture),
 * and inside the frame it plays back the last 4 beats from them, looping on the beat, through the frame's style.
 *
 * The pane is the frame exactly: its four corners through a homography (a frame held at an angle reads as glass at an
 * angle), a bevel that bends the picture at its border while the middle stays true, depth shading on the bevel, a
 * Fresnel rim (the kick glints it), a specular streak that slides with the tilt; the bass runs ripples across it. The
 * design's §8: a white edge with a glow in the mode's colour draws itself round (the top edge, then down the sides),
 * closes with one soft flash, and the style blooms in (scaling up from 60%); a white sweep crosses the pane once a loop
 * and each beat pulses it brighter (at most 3 a second); a restyle (a pinch) wipes the new style out from the middle.
 * frameLabel adds the big name (about a second, as an effect begins) and the amount bar. The styles, front ↔ flip side (the frame turned over, the loop backwards):
 *   ECHO TRAIL  dotted-1/8 echoes of the loop, warm   ↔ SLIT-SCAN  each column from its own moment of the loop
 *   PRISM       a rainbow split across it              ↔ X-RAY      the negative, cold, its edges lit
 *   HALFTONE    dots on the pane's own grid            ↔ SCANLINES  phosphor lines, a slow roll
 *   KALEIDO     mirror segments (more as it tilts)     ↔ MIRROR     a bilateral reflection, a seasick sway
 *   DATAMOSH    blocks melting down, more as it's held ↔ LIQUID     a slow, deep swirl
 *   THERMAL     heat colours from the light            ↔ ICE        frosted, crystals growing in, a slow shimmer
 * SHATTER on letting go (~140 ms): real glass: the pane cracks into fine Voronoi shards, each refracting the picture
 * its own way, lit at their edges, flying out from the middle and falling, motion-blurred; the live picture back at
 * once (geometry, no strobe). Reduced motion: the plain pane over a still. Outside the frame nothing changes; inside it can be bold:
 * the `--frame-*` tokens set how bold (stringTokens.ts). Colour is premultiplied (the canvas's default).
 */
import type { Pt } from '@/components/camera/camMath'
import { GLASS_LABEL, loopTime, type FrameCorners, type GlassFrame, type GlassType, type PaneFrame } from './glass'
import { liveFrameTokens, rgba, type StringsMode } from './stringTokens'

const TYPE: Record<GlassType, number> = {
  thermal: 0, xray: 1, halftone: 2, prism: 3, kaleido: 4, datamosh: 5, plain: 6, ice: 7, mirror: 8, echo: 9, slitscan: 10, scanlines: 11, liquid: 12,
}
const PX = 982 // the frame tokens' px: the design window's height
const PULSE_GAP_MS = 334 // at most 3 beat pulses a second

const VERT = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D uSrc;          // the live camera
uniform highp sampler2DArray uRing; // the camera's last seconds
uniform float uLayer;     // the ring's layer the loop shows now
uniform float uLoop;      // 1: the loop, 0: the live camera (no history yet)
uniform vec2 uRes;        // the canvas, px
uniform mat3 uH;          // the pane's uv (0-1) → the picture's uv (0-1, y down): the frame's four corners
uniform mat3 uHi;         // and back
uniform vec2 uSize;       // the pane's width and height, picture heights
uniform float uTilt;      // its top edge's angle, radians, clockwise
uniform int uType;        // 0 thermal 1 xray 2 halftone 3 prism 4 kaleido 5 datamosh 6 plain 7 ice 8 mirror 9 echo
                          // 10 slitscan 11 scanlines 12 liquid
uniform float uFlip;      // the card-flip so far, 0-1 (1: done)
uniform int uFlipFrom;    // the style it flips from
uniform int uPrev;        // the style a restyle wipes from
uniform float uRestyle;   // how far the new style has wiped over it, 0-1
uniform float uMix;       // the pane's opacity
uniform float uEdge;      // the lit edge drawn so far, 0-1
uniform float uBloom;     // the world (frost) bloomed in, 0-1
uniform float uFlash;     // the soft flash as the edge closes, 0-1
uniform float uCrack;     // -1, or 0-1 through the shatter
uniform float uBass;      // 0-1, smoothed
uniform float uKick;      // 0-1, a decaying envelope
uniform float uTime;      // seconds
uniform float uAge;       // seconds since the pane formed
uniform float uReduced;
uniform float uWorld;     // the most the world replaces the picture
uniform float uDisp;      // the most the glass moves a pixel, picture heights
uniform float uGlint;     // the kick's glint on the rim
uniform vec3 uEdgeCol;
uniform float uEdgeW;     // the lit edge's width, picture heights
uniform float uFlashA;
uniform float uDepth;
uniform vec3 uIce;
uniform float uFrost;
uniform float uBlur;      // picture heights
uniform float uShimmer;   // seconds a sweep
uniform vec2 uGrid;       // the shatter: its shards, a jittered columns x rows grid
uniform float uDist;      // how far they're flung, picture heights
uniform float uEase;      // how hard they ease out (the power)
uniform float uBlurStep;  // the shatter's motion blur: one frame's share of it
uniform vec3 uGlowCol;    // the edge's glow (the mode's)
uniform float uGlowBlur;  // how far it spreads, picture heights
uniform float uRadius;    // the pane's corners, picture heights
uniform vec4 uSweep;      // the sweep's colour and opacity
uniform float uSweepW;    // its width, picture heights
uniform float uProgress;  // where it is across the pane, 0-1 (-1: none)
uniform float uPulse;     // the beat pulse now: the brightness it adds
uniform vec3 uEcho;       // ECHO TRAIL: the ring's layers its three echoes show
uniform vec4 uScan;       // SLIT-SCAN: the moment into the loop (ms), its length (ms), its start's age (ms), the newest layer
uniform float uFrameMs;   // the ring's frame spacing (ms)
out vec4 o;

float aspect() { return uRes.x / uRes.y; }
mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, s, -s, c); }
vec2 proj(mat3 m, vec2 p) { vec3 r = m * vec3(p, 1.0); return r.xy / r.z; }
// Pane space q: picture heights, centred, x along the top edge, y down. The picture's uv of pane point q, and back.
vec2 toUv(vec2 q) { return proj(uH, q / uSize + 0.5); }
vec2 toPane(vec2 uv) { return (proj(uHi, uv) - 0.5) * uSize; }
vec3 ringAt(vec2 uv, float layer) {
  uv = clamp(uv, 0.0, 1.0);
  return uLoop > 0.5 ? texture(uRing, vec3(uv, layer)).rgb : texture(uSrc, uv).rgb;
}
vec3 src(vec2 uv) { return ringAt(uv, uLayer); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float hash1(float n) { return fract(sin(n * 127.1) * 43758.5453); }
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec2 capped(vec2 d, float m) { float l = length(d); return l > m ? d * (m / l) : d; }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + 1.0), f.x), f.y);
}

// The pane: a rounded rect in pane space (signed distance, picture heights; < 0 inside) and its outward normal.
vec2 half_() { return 0.5 * uSize; }
float corner() { return min(uRadius, 0.5 * min(uSize.x, uSize.y)); }
float sdPane(vec2 q) { vec2 d = abs(q) - half_() + corner(); return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - corner(); }
vec2 normalAt(vec2 q) {
  float e = 0.002;
  return normalize(vec2(sdPane(q + vec2(e, 0.0)) - sdPane(q - vec2(e, 0.0)), sdPane(q + vec2(0.0, e)) - sdPane(q - vec2(0.0, e))) + 1e-6);
}
float bevel() { return 0.18 * min(uSize.x, uSize.y); }

vec3 thermal(float t) {
  vec3 a = mix(vec3(0.02, 0.0, 0.12), vec3(0.45, 0.0, 0.6), smoothstep(0.0, 0.3, t));
  a = mix(a, vec3(0.95, 0.2, 0.15), smoothstep(0.3, 0.55, t));
  a = mix(a, vec3(1.0, 0.7, 0.1), smoothstep(0.55, 0.8, t));
  return mix(a, vec3(1.0, 1.0, 0.85), smoothstep(0.8, 1.0, t));
}
vec3 rainbow(float h) { return 0.5 + 0.5 * cos(6.28318 * (h + vec3(0.0, 0.33, 0.67))); }

// When the edge at q has drawn, 0-1 (the design's): the top edge left to right in the first half, then down the sides
// to the bottom.
float around(vec2 q) {
  vec2 uv = clamp(q / uSize + 0.5, 0.0, 1.0);
  bool top = uv.y * uSize.y < min(min(uv.x * uSize.x, (1.0 - uv.x) * uSize.x), (1.0 - uv.y) * uSize.y);
  return top ? 0.5 * uv.x : 0.5 + 0.5 * uv.y;
}

// What the pane shows at q: the picture (the loop) bent by the bevel and the ripples, through style ty.
vec3 pane(vec2 q, int ty) {
  float px = 1.0 / uRes.y;
  float e = -sdPane(q);
  float bend = pow(clamp(1.0 - e / bevel(), 0.0, 1.0), 2.0);
  vec2 n = normalAt(q);
  float r = uReduced > 0.5 ? 0.0 : 1.0;
  vec2 g = q;
  if (ty == 4) {                         // KALEIDO: folded about the pane's centre, the same scale
    float seg = 4.0 + 2.0 * floor(abs(uTilt) / 0.7854 * 3.0 + 0.5);
    float k = 6.28318 / seg;
    float a = atan(g.y, g.x) + uTime * 0.1;
    a = abs(mod(a, k) - 0.5 * k);
    g = vec2(cos(a), sin(a)) * length(g);
  } else if (ty == 8) {                  // MIRROR: a bilateral reflection with a slow seasick sway
    g.x = abs(g.x) - 0.004;
    g += vec2(sin(g.y * 9.0 + uTime * 1.3), sin(g.x * 12.0 + uTime * 2.0)) * 0.01;
  } else if (ty == 12) {                 // LIQUID: a slow, deep swirl about the middle
    float rr = length(g) / (0.5 * min(uSize.x, uSize.y));
    g = rot((2.2 * (1.0 - smoothstep(0.0, 1.3, rr)) * sin(uTime * 0.35) + 0.5 * sin(uTime * 0.2)) * rr) * g;
    g += vec2(sin(g.y * 14.0 + uTime * 0.9), cos(g.x * 12.0 - uTime * 0.7)) * 0.008;
  } else if (ty == 5) {                  // DATAMOSH: blocks sliding down, melting the longer it's held
    vec2 b = floor(g / (14.0 * px));
    float melt = min(uAge, 3.0) * (0.01 + 0.03 * hash(vec2(b.x, 1.0)));
    g.y -= min(melt, 2.0 * uDisp) + min(0.01 * uBass, uDisp) * hash(b + floor(uTime * 3.0)); // re-cut 3 times a second
    g = (floor(g / (6.0 * px)) + 0.5) * 6.0 * px;
  }
  vec2 dir = vec2(cos(uTilt * 0.5 + 0.6), sin(uTilt * 0.5 + 0.6));
  vec2 off = dir * r * (0.0025 + 0.006 * uBass) * sin(dot(q, dir) * 55.0 - uTime * 7.0);  // the bass's ripples, running across
  off += r * (vec2(hash(floor(q / (2.0 * px))), hash(floor(q / (2.0 * px)) + 7.0)) - 0.5) * 0.0012;  // micro-frost
  off = capped(off - n * bend * 0.07, uDisp * (0.35 + 0.65 * uBloom));                   // the bevel's refraction
  vec2 split = ty == 3 ? vec2(cos(uTilt * 2.0), sin(uTilt * 2.0)) * (0.008 + 0.01 * uBass) : -n * bend * 0.012;
  split = capped(split, 0.5 * uDisp);
  vec2 uv = toUv(g + off);
  vec2 du = toUv(g + off + split) - uv;
  vec3 col = vec3(src(uv + du).r, src(uv).g, src(uv - du).b);
  vec3 truth = src(toUv(q + off));
  vec2 pu = q / uSize + 0.5;
  if (ty == 10) {                                                                      // SLIT-SCAN: each column its own moment
    float into = mod(uScan.x - pu.x * uScan.y, uScan.y);
    col = ringAt(uv, mod(uScan.w - floor((uScan.z - into) / uFrameMs + 0.5), 128.0));
  }
  if (ty == 7) {
    // ICE: the picture blurred and cooled, frost crystals growing in from the edge
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 12; i++) {
      float a = float(i) * 2.39996;
      acc += src(toUv(q + off + vec2(cos(a), sin(a)) * sqrt((float(i) + 0.5) / 12.0) * uBlur));
    }
    vec3 blur = acc / 12.0;
    float frost = vnoise(q * 90.0) * 0.6 + vnoise(q * 260.0) * 0.4;
    float inward = clamp(e / (0.5 * min(uSize.x, uSize.y)), 0.0, 1.0);                   // 0 at the edge … 1 in the middle
    if (uReduced > 0.5) inward = 0.0;
    float grown = 1.0 - smoothstep(uBloom * 1.25 - 0.25, uBloom * 1.25, inward);
    vec3 ice = mix(blur, uIce, 0.3 + 0.25 * uFrost) * 1.06 + uIce * (frost - 0.45) * 0.35 * uFrost;
    ice += uIce * smoothstep(0.78, 0.95, frost) * 0.25 * uFrost * (1.0 - inward * 0.6);  // crystals, more at the edge
    float sweep = fract(uAge / uShimmer) * 1.8 - 0.4;                                     // the slow shimmer
    ice += uIce * (1.0 - uReduced) * 0.12 * exp(-pow((dot(pu, normalize(vec2(1.0, 0.6))) - sweep) / 0.06, 2.0));
    return mix(truth, ice, grown * (0.55 + 0.45 * uFrost));
  }
  if (ty == 9) {                                                                       // ECHO TRAIL: three echoes, warmer as they age
    // a weighted mix (screening them blew a bright room out to white)
    vec3 e = ringAt(uv, uEcho.x) * 0.5 + ringAt(uv, uEcho.y) * 0.3 + ringAt(uv, uEcho.z) * 0.2;
    col = col * 0.55 + e * vec3(1.0, 0.62, 0.36) * 0.75;
  } else if (ty == 11) {                                                              // SCANLINES: phosphor lines, a slow roll
    float on = step(0.5, fract(q.y / (4.0 * px)));
    float roll = exp(-pow((pu.y - fract(uTime * 0.25)) / 0.08, 2.0));
    col = vec3(lum(col)) * vec3(0.72, 1.0, 0.84) * (1.2 * (0.3 + 0.7 * on) + 0.25 * roll);
  } else if (ty == 0) col = thermal(clamp(lum(col) * 1.15, 0.0, 1.0));
  else if (ty == 1) {
    float ed = length(vec2(lum(src(uv + vec2(px, 0.0))) - lum(src(uv - vec2(px, 0.0))), lum(src(uv + vec2(0.0, px))) - lum(src(uv - vec2(0.0, px)))));
    col = (1.0 - vec3(lum(col))) * vec3(0.7, 0.88, 1.0) + vec3(0.6, 0.85, 1.0) * clamp(ed * 4.0, 0.0, 1.0);
  } else if (ty == 2) {
    float cell = 7.0 * px;
    vec2 h = rot(0.785) * g;
    vec2 c = (floor(h / cell) + 0.5) * cell;
    float l = lum(src(toUv(rot(-0.785) * c + off)));
    float dot_ = 1.0 - smoothstep(0.0, px, length(h - c) - 0.5 * cell * sqrt(1.0 - l));
    col = mix(vec3(0.94, 0.9, 0.82), vec3(0.06, 0.05, 0.05), dot_);
  } else if (ty == 3) col = mix(col, col * rainbow(dot(q, vec2(1.0, 0.4)) * 2.0 + uTime * 0.1) * 1.5, 0.45);
  else if (ty == 8) col = mix(col, vec3(lum(col)) * vec3(0.9, 0.97, 1.06) * 1.1, 0.45);  // a cool silver cast
  col = mix(truth, col, uWorld);  // the camera always reads through the world
  // Surface: a faint smudge, depth on the bevel (lit from the top left), the Fresnel rim (the kick glints it), a streak.
  col *= 0.97 + 0.06 * hash(floor(q / (40.0 * px)));
  col *= 1.0 + 0.3 * uDepth * bend * dot(n, normalize(vec2(-0.55, -0.85)));
  float fres = pow(clamp(1.0 - e / (0.6 * bevel()), 0.0, 1.0), 3.0);
  col += vec3(1.0, 0.97, 0.92) * fres * (0.2 + uGlint * r * uKick);
  float s = dot(q / half_(), normalize(vec2(1.0, -0.7)));
  float s0 = clamp(uTilt / 0.7854, -1.0, 1.0) * 0.9;
  col += vec3(1.0) * uBloom * (exp(-pow((s - s0) / 0.12, 2.0)) * 0.1 + exp(-pow((s - s0 - 0.22) / 0.035, 2.0)) * 0.08);
  return col;
}

// The shatter: the pane (its uv) cut into a jittered-grid Voronoi (uGrid's columns x rows shards)
vec2 seedOf(vec2 cell) { return (cell + 0.15 + 0.7 * vec2(hash(cell + 11.3), hash(cell + 27.1))) / uGrid; }
// the shard (its grid cell) a pane-uv point is in, and how far it is from that shard's edge (picture heights)
vec3 shardAt(vec2 u) {
  vec2 g = floor(u * uGrid);
  float d1 = 1e9, d2 = 1e9;
  vec2 best = g;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec2 c = g + vec2(float(x), float(y));
    vec2 dv = (u - seedOf(c)) * uSize;
    float d = dot(dv, dv);
    if (d < d1) { d2 = d1; d1 = d; best = c; } else if (d < d2) d2 = d;
  }
  return vec3(best, 0.5 * (sqrt(d2) - sqrt(d1)));
}
// one moment (k, 0-1) of the fracture at picture point P (aspect units): the colour and coverage of whichever shard
// has flown there. Each shard flies out from the middle and falls, turning, refracting the picture its own way.
vec4 fractureAt(vec2 P, vec2 C, float k) {
  float go = 1.0 - pow(1.0 - clamp((k - 0.06) / 0.94, 0.0, 1.0), uEase);   // the cracks show first, then they fly
  int cols = int(uGrid.x);
  for (int j = 0; j < 64; j++) {
    if (j >= cols * int(uGrid.y)) break;
    vec2 cell = vec2(float(j - (j / cols) * cols), float(j / cols));
    vec2 S0 = toUv((seedOf(cell) - 0.5) * uSize);
    vec2 S = vec2(S0.x * aspect(), S0.y);
    vec2 away = normalize(S - C + 1e-4);
    float h = hash(cell + 3.1);
    vec2 fly = away * uDist * (0.45 + 0.9 * h) * go + vec2(0.0, 0.9 * k * k) * uDist; // out, then down
    float th = (hash(cell + 9.2) - 0.5) * 3.0 * go;
    float sc = 1.0 - 0.35 * go * hash(cell + 5.5);                                   // turning away in depth
    vec2 P0 = S + rot(-th) * (P - S - fly) / sc;
    vec2 u = proj(uHi, vec2(P0.x / aspect(), P0.y));
    vec2 q = (u - 0.5) * uSize;
    if (sdPane(q) > 0.0) continue;
    vec3 sh = shardAt(u);
    if (sh.x != cell.x || sh.y != cell.y) continue;
    vec2 refr = (vec2(hash(cell + 1.7), hash(cell + 4.4)) - 0.5) * 0.03 * go;       // each shard bends it its own way
    vec3 col = pane(q + refr, uType);
    float px = 1.0 / uRes.y;
    col = mix(col, uEdgeCol, clamp(exp(-sh.z / (1.1 * px)) * 1.2, 0.0, 1.0));       // lit edges
    col += uEdgeCol * 0.35 * pow(abs(sin(th * 2.0 + 6.0 * h)), 12.0);              // a glint as it turns
    return vec4(col, 1.0 - smoothstep(0.75, 1.0, k));
  }
  return vec4(0.0);
}

void main() {
  vec2 puv = vec2(gl_FragCoord.x / uRes.x, 1.0 - gl_FragCoord.y / uRes.y);
  float px = 1.0 / uRes.y;
  vec3 col = vec3(0.0);
  float a = 0.0;
  if (uCrack < 0.0) {
    vec2 q = toPane(puv);
    // the card-flip as the frame turns over: the pane narrows to its edge and opens again, the style changing edge-on
    float card = uFlip < 1.0 ? cos(3.14159 * uFlip) : 1.0;
    if (abs(card) < 1.0) {
      if (abs(q.x) > 0.5 * uSize.x * abs(card)) discard;
      q.x /= max(abs(card), 0.02);
    }
    int face = uFlip < 0.5 ? uFlipFrom : uType;
    float d = -sdPane(q);
    if (d < -(2.5 * uGlowBlur + 2.0 * uEdgeW)) discard;
    // the style blooms in, scaling up from 60%
    float sc = uReduced > 0.5 ? 1.0 : 0.6 + 0.4 * uBloom;
    vec2 qs = q / sc;
    float inside = smoothstep(-px, px, -sdPane(qs)) * (uReduced > 0.5 ? 1.0 : uBloom);
    col = vec3(0.0);
    if (inside > 0.0) {
      col = pane(qs, face) * (0.55 + 0.45 * abs(card));
      if (uRestyle < 1.0) {  // a pinch: the new style wipes out from the middle over the old one
        float reach = length(qs / uSize * 2.0) / 1.4142;
        col = mix(pane(qs, uPrev), col, 1.0 - smoothstep(uRestyle * 1.3 - 0.3, uRestyle * 1.3, reach));
      }
      // the beat's pulse: brighter, a little more saturated (the design's 1.6x, 1.4x)
      col = mix(vec3(lum(col)), col, 1.0 + 0.67 * uPulse) * (1.0 + uPulse);
      // the sweep: a white line across the pane once a loop
      if (uProgress >= 0.0) {
        float dx = abs(qs.x / uSize.x + 0.5 - uProgress) * uSize.x;
        float core = 1.0 - smoothstep(0.5 * uSweepW - px, 0.5 * uSweepW + px, dx);
        col = mix(col, uSweep.rgb, uSweep.a * core) + uSweep.rgb * 0.45 * exp(-pow(dx / (6.0 / 982.0), 2.0));
      }
    }
    // the one soft flash as the edge closes, brightest at the edge
    col += uEdgeCol * uFlash * uFlashA * (0.3 + 0.7 * exp(-max(d, 0.0) / (0.15 * min(uSize.x, uSize.y))));
    // the edge: a crisp white band just outside the pane, a glow in the mode's colour beyond it, drawn so far
    float drawn = uReduced > 0.5 ? 1.0 : smoothstep(uEdge + 0.004, uEdge - 0.004, around(q));
    float band = clamp((d + uEdgeW) / px + 0.5, 0.0, 1.0) * clamp(-d / px + 0.5, 0.0, 1.0) * drawn;
    float glow = d < 0.0 ? exp(-pow(max(0.0, -d - uEdgeW) / (0.5 * uGlowBlur), 2.0)) * 0.8 * drawn : 0.0;
    vec3 rim = mix(uGlowCol, uEdgeCol, band);
    a = max(inside, max(band, glow));
    col = inside > 0.0 ? mix(col, uEdgeCol, band) : rim;
  } else {
    // SHATTER: the fine shards, motion-blurred over the frame's time
    float c = uCrack;
    vec2 centre = toUv(vec2(0.0));
    vec2 P = vec2(puv.x * aspect(), puv.y);
    vec2 C = vec2(centre.x * aspect(), centre.y);
    vec4 acc = vec4(0.0);
    for (int s = 0; s < 3; s++) {
      vec4 f = fractureAt(P, C, max(0.0, c - float(s) * uBlurStep / 3.0));
      acc += vec4(f.rgb * f.a, f.a);
    }
    a = acc.a / 3.0;
    col = a > 0.0 ? acc.rgb / (3.0 * a) : vec3(0.0);
    if (a <= 0.0) discard;
  }
  a = clamp(a, 0.0, 1.0) * uMix;
  o = vec4(col * a, a);
}`

export interface GlassAudio {
  bass: number
  kick: number
  time: number
  /** The stage's clock (performance.now ms): where the loop is. Defaults to performance.now(). */
  now?: number
}

/** The ring: the camera's last ~4.3 s at 30 frames a second (4 beats down to 60 BPM), 480 x 270, ~66 MB of GPU memory. */
export const RING = { width: 480, height: 270, frames: 128 }
export const RING_BYTES = RING.width * RING.height * 4 * RING.frames

/** The homography taking the unit square (u right, v down) onto the corners (clockwise from the top-left), as rows. */
export function squareToQuad(c: FrameCorners): number[] {
  const [p0, p1, p2, p3] = c
  const dx1 = p1.x - p2.x
  const dx2 = p3.x - p2.x
  const dx3 = p0.x - p1.x + p2.x - p3.x
  const dy1 = p1.y - p2.y
  const dy2 = p3.y - p2.y
  const dy3 = p0.y - p1.y + p2.y - p3.y
  const den = dx1 * dy2 - dx2 * dy1
  const g = Math.abs(den) < 1e-12 ? 0 : (dx3 * dy2 - dx2 * dy3) / den
  const h = Math.abs(den) < 1e-12 ? 0 : (dx1 * dy3 - dx3 * dy1) / den
  return [p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x, p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y, g, h, 1]
}

export function invert3(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m as [number, number, number, number, number, number, number, number, number]
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C || 1e-12
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det)
}

/** Rows to the column-major order WebGL takes. */
const columns = (m: number[]) => [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!]

/** The pass, `width` x `height`: draw(source, pane, audio) renders the pane (or nothing) and returns its canvas. */
export function createGlassPass(width: number, height: number, opts: { reduced?: boolean; mode?: StringsMode } = {}) {
  const canvas = document.createElement('canvas')
  Object.assign(canvas, { width, height })
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false })
  const none = { canvas, draw: () => null as HTMLCanvasElement | null, record() {}, oldest: () => -Infinity, dispose() {} }
  if (!gl) return none
  const shader = (kind: number, text: string) => {
    const s = gl.createShader(kind)!
    gl.shaderSource(s, text)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn('glass shader:', gl.getShaderInfoLog(s))
    return s
  }
  const prog = gl.createProgram()!
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT))
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG))
  gl.linkProgram(prog)
  const ok = gl.getProgramParameter(prog, gl.LINK_STATUS) as boolean
  if (!ok) return none
  gl.useProgram(prog)
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'aPos')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  const texture = (unit: number) => {
    const tex = gl.createTexture()
    gl.activeTexture(gl.TEXTURE0 + unit)
    gl.bindTexture(gl.TEXTURE_2D, tex)
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]] as const)
      gl.texParameteri(gl.TEXTURE_2D, k, v)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4))
    return tex
  }
  const camTex = texture(0)
  // The ring: a texture array the camera's frames go into round and round.
  const ringTex = gl.createTexture()
  gl.activeTexture(gl.TEXTURE1)
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, ringTex)
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA8, RING.width, RING.height, RING.frames)
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]] as const)
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, k, v)
  const small = document.createElement('canvas')
  Object.assign(small, { width: RING.width, height: RING.height })
  const sctx = small.getContext('2d')
  const times = new Float64Array(RING.frames).fill(-Infinity)
  let head = 0
  const oldest = () => times.reduce((m, t) => (t > -Infinity && t < m ? t : m), Infinity)
  const newest = () => (head + RING.frames - 1) % RING.frames
  const frames = () => times.reduce((n, t) => n + (t > -Infinity ? 1 : 0), 0)
  const layerAt = (t: number) => {
    let best = -1
    let gap = Infinity
    for (let i = 0; i < RING.frames; i++) {
      const d = Math.abs(times[i]! - t)
      if (d < gap) [best, gap] = [i, d]
    }
    return best
  }
  const u = (name: string) => gl.getUniformLocation(prog, name)
  const NAMES = ['uFlip', 'uFlipFrom', 'uBlurStep', 'uRes', 'uH', 'uHi', 'uSize', 'uTilt', 'uType', 'uPrev', 'uRestyle', 'uLayer', 'uLoop', 'uMix', 'uEdge', 'uBloom', 'uFlash', 'uCrack', 'uBass', 'uKick',
    'uTime', 'uAge', 'uReduced', 'uWorld', 'uDisp', 'uGlint', 'uEdgeCol', 'uEdgeW', 'uFlashA', 'uDepth', 'uIce', 'uFrost', 'uBlur', 'uShimmer',
    'uGrid', 'uDist', 'uEase', 'uGlowCol', 'uGlowBlur', 'uRadius', 'uSweep', 'uSweepW', 'uProgress', 'uPulse', 'uEcho', 'uScan', 'uFrameMs']
  const U = Object.fromEntries(NAMES.map((n) => [n, u(n)]))
  gl.uniform1i(u('uSrc'), 0)
  gl.uniform1i(u('uRing'), 1)
  gl.uniform2f(U.uRes!, width, height)
  gl.uniform1f(U.uReduced!, opts.reduced ? 1 : 0)
  const tokens = liveFrameTokens()
  const aspect = width / height
  return {
    canvas,
    /** One new camera frame (the stage's picture, any size) into the ring, at `now` (performance.now ms). */
    record(source: CanvasImageSource, now: number) {
      if (!sctx) return
      sctx.drawImage(source, 0, 0, RING.width, RING.height)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, ringTex)
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, head, RING.width, RING.height, 1, gl.RGBA, gl.UNSIGNED_BYTE, small)
      times[head] = now
      head = (head + 1) % RING.frames
    },
    /** The ring's oldest frame (performance.now ms), or Infinity while it's empty. */
    oldest,
    /** The pane over `source` (the camera picture, the canvas's size), or null when there's nothing to draw. */
    draw(source: CanvasImageSource, f: PaneFrame, audio: GlassAudio): HTMLCanvasElement | null {
      if (!f.corners || f.mix <= 0) return null
      const tk = tokens(performance.now())
      const [p0, p1, p2, p3] = f.corners
      const len = (a: typeof p0, b: typeof p0) => Math.hypot((b.x - a.x) * aspect, b.y - a.y)
      const H = squareToQuad(f.corners)
      gl.viewport(0, 0, width, height)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      const now = audio.now ?? performance.now()
      const moment = f.loop ? loopTime(f.loop, now, f.flipped) : 0 // the flip side: backwards
      const layer = f.loop ? layerAt(moment) : -1
      gl.uniform1f(U.uLoop!, layer >= 0 ? 1 : 0)
      gl.uniform1f(U.uLayer!, Math.max(0, layer))
      if (layer < 0) { // no history yet: the live camera
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, camTex)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource)
      }
      gl.uniformMatrix3fv(U.uH!, false, columns(H))
      gl.uniformMatrix3fv(U.uHi!, false, columns(invert3(H)))
      gl.uniform2f(U.uSize!, Math.max(0.02, (len(p0, p1) + len(p3, p2)) / 2), Math.max(0.02, (len(p0, p3) + len(p1, p2)) / 2))
      gl.uniform1f(U.uTilt!, Math.atan2(p1.y - p0.y, (p1.x - p0.x) * aspect))
      gl.uniform1i(U.uType!, TYPE[f.type])
      gl.uniform1i(U.uPrev!, TYPE[f.prev])
      gl.uniform1f(U.uFlip!, f.flip)
      gl.uniform1i(U.uFlipFrom!, TYPE[f.flipFrom])
      gl.uniform1f(U.uRestyle!, f.restyle)
      gl.uniform1f(U.uMix!, f.mix)
      gl.uniform1f(U.uEdge!, f.edge)
      gl.uniform1f(U.uBloom!, f.bloom)
      gl.uniform1f(U.uFlash!, f.flash)
      gl.uniform1f(U.uCrack!, f.crack)
      gl.uniform1f(U.uAge!, f.age)
      gl.uniform1f(U.uBass!, audio.bass)
      gl.uniform1f(U.uKick!, audio.kick)
      gl.uniform1f(U.uTime!, audio.time)
      gl.uniform1f(U.uWorld!, tk.worldOpacity)
      gl.uniform1f(U.uDisp!, tk.displace / PX)
      gl.uniform1f(U.uGlint!, tk.glint)
      gl.uniform3f(U.uEdgeCol!, tk.edge[0] / 255, tk.edge[1] / 255, tk.edge[2] / 255)
      gl.uniform1f(U.uEdgeW!, tk.edgeWidth / PX)
      const glow = tk.glow[opts.mode ?? 'remix']
      gl.uniform3f(U.uGlowCol!, glow[0] / 255, glow[1] / 255, glow[2] / 255)
      gl.uniform1f(U.uGlowBlur!, tk.glowBlur / PX)
      gl.uniform1f(U.uRadius!, tk.radius / PX)
      gl.uniform4f(U.uSweep!, tk.sweep[0] / 255, tk.sweep[1] / 255, tk.sweep[2] / 255, tk.sweep[3])
      gl.uniform1f(U.uSweepW!, 3 / PX) // the design's 3 px line
      gl.uniform1f(U.uProgress!, f.clock && f.mix > 0 ? f.clock.progress : -1)
      let pulse = 0
      const echoes = [0, 0, 0]
      if (f.loop && f.clock) {
        const beatMs = f.loop.length / f.loop.beats
        const every = beatMs * Math.ceil(PULSE_GAP_MS / beatMs) // a pulse each beat, at most 3 a second
        const x = ((((now - f.loop.end) % every) + every) % every) / beatMs / 0.4 // through the pulse: 40% of a beat
        pulse = x < 1 ? tk.pulse * (1 - x) ** 2 : 0
        echoes.forEach((_, k) => (echoes[k] = Math.max(0, layerAt(loopTime(f.loop!, now - (k + 1) * 0.75 * beatMs, f.flipped))))) // dotted 1/8s
      }
      gl.uniform1f(U.uPulse!, pulse)
      gl.uniform3f(U.uEcho!, echoes[0]!, echoes[1]!, echoes[2]!)
      const n = frames()
      const latest = times[newest()]!
      gl.uniform1f(U.uFrameMs!, n > 1 ? Math.max(1, (latest - oldest()) / (n - 1)) : 33)
      gl.uniform4f(U.uScan!, f.loop ? moment - f.loop.start : 0, f.loop ? f.loop.length : 1, f.loop ? latest - f.loop.start : 0, newest())
      gl.uniform1f(U.uFlashA!, tk.flashAlpha)
      gl.uniform1f(U.uDepth!, tk.depth)
      gl.uniform3f(U.uIce!, tk.ice[0] / 255, tk.ice[1] / 255, tk.ice[2] / 255)
      gl.uniform1f(U.uFrost!, tk.frost)
      gl.uniform1f(U.uBlur!, tk.blur / PX)
      gl.uniform1f(U.uShimmer!, tk.shimmerS)
      const cols = Math.max(2, Math.round(Math.sqrt(tk.fracture.shards * 1.2))) // a little wider than tall
      gl.uniform2f(U.uGrid!, cols, Math.max(2, Math.round(tk.fracture.shards / cols)))
      gl.uniform1f(U.uDist!, tk.fracture.distance)
      gl.uniform1f(U.uEase!, tk.fracture.ease)
      gl.uniform1f(U.uBlurStep!, 1000 / 30 / tk.fracture.ms)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, ringTex)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      return canvas
    },
    dispose() {
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    },
  }
}

const frameTokens = liveFrameTokens()

/** The effect's name shows big in the pane this long (s) whenever an effect begins (the pane forms, P or a pinch
 *  restyles it, a flip turns it over), then fades over FADE_S. */
const BIG_S = 1
const FADE_S = 0.35

/**
 * The frame's words over its pane (2D, on the composited canvas), "big text or no text" on an animation (the user's
 * rule): when an effect begins, its name big and centred in the pane (along its tilt) for about a second, then gone;
 * no small pill or digits. The amount is a thin bar along the pane's bottom (S1's frame size), never a number. The "how"
 * is S4's chip under the frame. Reduced motion: the name the same second, no fade-in, scale or fade-out ease.
 */
export function frameLabel(ctx: CanvasRenderingContext2D, g: GlassFrame, w: number, h: number, _mode: StringsMode = 'remix'): void {
  const early = g.flip < 0.5 // the card hasn't turned edge-on yet: still the old face
  const face = early ? g.flipFrom : g.type
  const name = GLASS_LABEL[face]
  if (!name || !g.corners || !g.quad || g.crack >= 0 || g.mix <= 0.01) return
  const tk = frameTokens(performance.now())
  const px = h / PX
  const still = g.clock === null // reduced motion
  const [, , p2, p3] = g.corners
  const lb = tk.label
  const flipped = early ? !g.flipped : g.flipped
  const title = name + (flipped ? ' ⟲' : '')

  // 1. the name, big, while its effect is new
  const t = g.styleAge
  const inK = still ? 1 : Math.min(1, Math.max(0, (t - 0.12) / 0.2))
  const outK = still ? (t >= BIG_S ? 1 : 0) : Math.min(1, Math.max(0, (t - BIG_S) / FADE_S))
  if (inK > 0 && outK < 1) {
    const size = Math.max((28 * w) / 1280, Math.min(96 * px, 2 * g.quad.hw * h * 0.2))
    ctx.save()
    ctx.translate(g.quad.x * w, g.quad.y * h)
    ctx.rotate(g.quad.tilt)
    const k = still ? 1 : 0.92 + 0.08 * inK - 0.06 * outK
    ctx.scale(k, k)
    ctx.globalAlpha = g.mix * inK * (1 - outK)
    ctx.font = `${lb.weight} ${size.toFixed(1)}px ${lb.font}`
    ctx.letterSpacing = `${(0.04 * size).toFixed(2)}px`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)'
    ctx.shadowBlur = 14 * px
    ctx.fillStyle = '#FFFFFF'
    ctx.fillText(title, 0, 0)
    ctx.restore()
  }

  // 2. the amount: a thin bar along the pane's bottom, 15-85% of its width, 22 px in
  if (g.amount === null || g.bloom <= 0.01) return
  const alpha = g.mix * (still ? 1 : Math.min(1, g.bloom * 1.5))
  const mid = { x: ((p3.x + p2.x) / 2) * w, y: ((p3.y + p2.y) / 2) * h }
  const to = { x: g.quad.x * w - mid.x, y: g.quad.y * h - mid.y }
  const tl = Math.hypot(to.x, to.y) || 1
  const inset = (p: Pt) => ({ x: p.x * w + (to.x / tl) * 22 * px, y: p.y * h + (to.y / tl) * 22 * px })
  const lerp = (a: Pt, b: Pt, u: number): Pt => ({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u })
  const a = inset(lerp(p3, p2, 0.15))
  const b = inset(lerp(p3, p2, 0.85))
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.lineCap = 'round'
  ctx.lineWidth = 4 * px
  ctx.strokeStyle = 'rgba(20, 12, 8, 0.32)' // dark, so it shows on a light pane as well as a dark one
  ctx.beginPath()
  ctx.moveTo(a.x, a.y)
  ctx.lineTo(b.x, b.y)
  ctx.stroke()
  if (g.amount > 0.005) {
    ctx.strokeStyle = rgba(tk.hint.dotOn, 1)
    ctx.beginPath()
    ctx.moveTo(a.x, a.y)
    ctx.lineTo(a.x + (b.x - a.x) * g.amount, a.y + (b.y - a.y) * g.amount)
    ctx.stroke()
  }
  ctx.restore()
}
