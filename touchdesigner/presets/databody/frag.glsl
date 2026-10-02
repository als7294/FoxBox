// DATA BODY: the camera as a monitor feed. The skeleton and the hands' bones drawn in, every joint, fingertip and face
// point bracketed and numbered; the face and each hand get a big bracket with a readout (the face's x / y, a hand's
// fingers up). REACTS TO: the brackets breathe. Snare: the counter ticks. The beat: a scan line sweeps down. Drop: the
// person goes red (held, never strobed).

const int P10[4] = int[4](1, 10, 100, 1000);

// n digits of v, left to right, each glyph g (w, h) in p units, from o (its bottom-left).
float number(int v, int n, vec2 p, vec2 o, vec2 g) {
    float s = 0.0;
    for (int k = 0; k < 4; k++) {
        if (k < n) s += digit((v / P10[n - 1 - k]) % 10, (p - o - vec2(float(k) * g.x * 1.4, 0.0)) / g);
    }
    return s;
}

// A rectangle's outline, centre c, half-size h, line width w.
float frame(vec2 p, vec2 c, vec2 h, float w) {
    vec2 d = abs(p - c) - h;
    float e = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
    return 1.0 - smoothstep(0.0, w, abs(e));
}

// Its corners only: a bracket.
float bracket(vec2 p, vec2 c, vec2 h, float w) {
    vec2 q = abs(p - c);
    return frame(p, c, h, w) * step(h.x * 0.55, q.x) * step(h.y * 0.55, q.y);
}

void main() {
    vec2 res = uTDOutputInfo.res.zw;
    float aspect = res.x / res.y;
    vec2 uv = vUV.st;
    vec2 p = uv * vec2(aspect, 1.0);
    float px = 1.0 / res.y;
    float pulse = uReact.x, drop = uAudio.z;
    float grid = uMacro.x, labels = uMacro.y, mono = uMacro.z;

    // The feed: mono and posterized (MONO), the room dimmed, the person red in a drop.
    vec3 c = cam(uv);
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float lp = floor(l * 5.0) / 4.0;
    float who = person(uv);
    vec3 col = mix(c * 0.85, mix(uPal0.rgb, uPal2.rgb, lp), mono);
    col = mix(col, mix(uPal0.rgb, uPal1.rgb, min(1.0, lp * 1.4)), smoothstep(0.3, 0.8, drop) * who);
    col *= 0.45 + 0.55 * max(who, 1.0 - step(0.5, uCam.x));

    // The grid (GRID) and the beat's scan line.
    vec2 gq = uv * vec2(32.0, 18.0);
    vec2 gf = fract(gq), gw = fwidth(gq);
    float lines = max(step(gf.x, gw.x), step(gf.y, gw.y));
    col = mix(col, uPal2.rgb, lines * 0.12 * grid);
    float sy = 1.0 - uGrid.y;
    float scan = (1.0 - smoothstep(0.0, 2.0 * px, abs(uv.y - sy))) + 0.25 * smoothstep(0.08, 0.0, uv.y - sy) * step(sy, uv.y);
    col = mix(col, uPal1.rgb, clamp(scan, 0.0, 1.0) * 0.55 * grid);

    // The points: a bracket, a dot and a number each, joined to the next (11 closes the outline; a far jump is the
    // next group, not a line).
    float joins = 0.0, marks = 0.0, nums = 0.0, n = 0.0;
    vec2 lo = vec2(1e3), hi = vec2(-1e3);
    vec2 g = vec2(5.0, 8.0) * px;
    float h = (5.0 + 7.0 * pulse) * px;
    for (int i = 0; i < 32; i++) {
        if (uPts[i].x < 0.0) continue;
        vec2 a = ptToUV(uPts[i]) * vec2(aspect, 1.0);
        lo = min(lo, a);
        hi = max(hi, a);
        n += 1.0;
        marks += bracket(p, a, vec2(h), 1.5 * px) + 1.0 - smoothstep(1.0 * px, 2.5 * px, length(p - a));
        if (labels > 0.66 || (labels > 0.2 && i % 4 == 0)) nums += number(i, 2, p, a + vec2(h + 3.0 * px, h), g);
        int j = i == 11 ? 0 : i + 1;
        if (j < 32 && uPts[j].x >= 0.0) {
            vec2 b = ptToUV(uPts[j]) * vec2(aspect, 1.0);
            if (length(a - b) < 0.3) joins += 1.0 - smoothstep(0.5 * px, 1.8 * px, segment(p, a, b));
        }
    }

    // The body: the arms and torso and the hands' bones as lines; each joint and fingertip a bracket and its number.
    float skel = 1.0 - smoothstep(0.6 * px, 2.0 * px, min(bones(uv), fingers(uv)));
    for (int i = 11; i < 25; i++) {
        if (!jointOn(i)) continue;
        vec2 a = scr(joint(i));
        marks += bracket(p, a, vec2(h * 1.3), 1.5 * px);
        if (labels > 0.2) nums += number(i, 2, p, a + vec2(h * 1.3 + 3.0 * px, h), g);
    }
    for (int s = 0; s < 2; s++) {
        if (!handOn(s)) continue;
        vec2 hlo = vec2(1e3), hhi = vec2(-1e3);
        for (int i = 0; i < 21; i++) {
            vec2 a = scr(handPt(s, i));
            hlo = min(hlo, a);
            hhi = max(hhi, a);
            if (i % 4 == 0 && i > 0) {
                marks += bracket(p, a, vec2(h * 0.8), 1.2 * px);
                if (labels > 0.66) nums += number(s * 21 + i, 2, p, a + vec2(h + 2.0 * px, h * 0.5), g);
            }
        }
        // The hand's bracket and its fingers up, big.
        vec2 hc = 0.5 * (hlo + hhi), hh = 0.5 * (hhi - hlo) + vec2(14.0 * px) * (1.0 + 0.4 * pulse);
        col = mix(col, uPal1.rgb, bracket(p, hc, hh, 2.0 * px));
        float up = s == 0 ? uShapeL.z : uShapeR.z;
        col = mix(col, uPal2.rgb, clamp(number(int(up + 0.5), 1, p, hc + vec2(-hh.x, hh.y + 6.0 * px), vec2(9.0, 15.0) * px), 0.0, 1.0));
    }
    col = mix(col, uPal2.rgb, skel * 0.85);

    // The face (or body) bracket and its readout: the centre's x and y (0-999 of the frame) and the snare counter.
    if (n > 2.0) {
        vec2 c0 = 0.5 * (lo + hi);
        vec2 h0 = 0.5 * (hi - lo) + vec2(22.0 * px) * (1.0 + 0.4 * pulse);
        col = mix(col, uPal1.rgb, bracket(p, c0, h0, 2.5 * px));
        vec2 G = vec2(7.0, 11.0) * px;
        vec2 o = c0 + vec2(-h0.x, h0.y + 8.0 * px);
        vec2 cu = clamp(c0 / vec2(aspect, 1.0), 0.0, 0.999);
        float ro = number(int(cu.x * 1000.0), 3, p, o, G)
                 + number(int(cu.y * 1000.0), 3, p, o + vec2(G.x * 5.2, 0.0), G)
                 + number(int(uGrid.w) % 1000, 3, p, o + vec2(G.x * 10.4, 0.0), G);
        col = mix(col, uPal2.rgb, clamp(ro, 0.0, 1.0));
        // Faint crosshair lines from the bracket to the frame's edges.
        float cross = (1.0 - smoothstep(0.0, 1.0 * px, abs(p.y - c0.y))) * step(h0.x, abs(p.x - c0.x))
                    + (1.0 - smoothstep(0.0, 1.0 * px, abs(p.x - c0.x))) * step(h0.y, abs(p.y - c0.y));
        col = mix(col, uPal2.rgb, cross * 0.18 * grid);
    }
    col = mix(col, uPal2.rgb, clamp(joins, 0.0, 1.0) * 0.75);
    col = mix(col, uPal1.rgb, clamp(marks, 0.0, 1.0));
    col = mix(col, uPal2.rgb, clamp(nums, 0.0, 1.0));
    fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
