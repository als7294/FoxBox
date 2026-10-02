// MIRROR TUNNEL: the room behind the person becomes a kaleidoscope tunnel of the picture, repeating inward ring after
// ring; the person stays in front. With both hands up it opens between them and spreading the arms adds mirrors; else
// round the face. Raised hands' fingertips glow through. REACTS TO: the tunnel lurches inward. The beat: the mirrors
// turn a step. Snare: a colour split. Drop: twice the mirrors, and the person goes into the tunnel too.

// A triangle wrap: uv outside 0-1 mirrored back in.
vec2 fold(vec2 u) { return 1.0 - abs(1.0 - mod(u, 2.0)); }

void main() {
    vec2 res = uTDOutputInfo.res.zw;
    float aspect = res.x / res.y;
    vec2 uv = vUV.st;
    vec2 p = uv * vec2(aspect, 1.0);
    float pulse = uReact.x, snare = uAudio.y, drop = uAudio.z, t = uAudio.w;
    float segs = uMacro.x, speed = uMacro.y, twist = uMacro.z, depth = uMacro.w;

    // The centre: the nose tip, else the points' middle, else the frame's.
    vec2 c = vec2(0.0);
    float n = 0.0;
    for (int i = 0; i < 32; i++) {
        if (uPts[i].x < 0.0) continue;
        c += ptToUV(uPts[i]);
        n += 1.0;
    }
    c = uPts[23].x >= 0.0 ? ptToUV(uPts[23]) : n > 0.0 ? c / n : vec2(0.5);
    c *= vec2(aspect, 1.0);
    bool both = handOn(0) && handOn(1);
    if (both) c = 0.5 * (scr(handPt(0, 9)) + scr(handPt(1, 9)));
    else if (jointOn(11) && jointOn(12)) c = mix(c, 0.5 * (scr(joint(11)) + scr(joint(12))), 0.3); // steadied by the shoulders

    vec2 q = p - c;
    float r = length(q);
    float R = mix(0.2, 0.45, depth);
    float spread = both ? clamp(uShape.x * 1.6, 0.0, 1.0) : segs; // the hands apart sets the mirrors
    float mirrors = floor(mix(3.0, 12.0, spread)) * (1.0 + step(0.5, drop));
    float seg = 6.28318 / mirrors;
    float z = log2(max(r, 1e-4) / R) - t * mix(0.05, 0.6, speed) - 0.35 * pulse;
    float ring = floor(z);
    float turn = (floor(uGrid.x) + smoothstep(0.0, 0.25, uGrid.y)) * seg * 0.5;
    float a = abs(mod(atan(q.y, q.x) + turn + ring * twist * 1.2, seg) - 0.5 * seg) + 1.5708 - 0.25 * seg;
    // Every ring shows the same annulus round the face (R/2 to R), the snare splitting its colours.
    float rs = R * 0.5 * exp2(fract(z));
    vec2 dir = vec2(cos(a), sin(a));
    float split = 0.015 * snare;
    vec3 col = vec3(cam(fold((c + dir * rs * (1.0 + split)) / vec2(aspect, 1.0))).r,
                    cam(fold((c + dir * rs) / vec2(aspect, 1.0))).g,
                    cam(fold((c + dir * rs * (1.0 - split)) / vec2(aspect, 1.0))).b);
    // Every other ring toward palette 1, a fine line at each ring's edge, the far rings darker.
    float odd = mod(ring, 2.0);
    col = mix(col, dot(col, vec3(0.2126, 0.7152, 0.0722)) * uPal1.rgb * 1.3, 0.45 * odd);
    col = mix(col, uPal2.rgb, (1.0 - smoothstep(0.0, 0.04, fract(z))) * 0.6);
    col *= 1.0 - 0.45 * smoothstep(0.6, 1.3, r);

    // The person in front (the face whole at the centre before there's a matte), except in a drop.
    float front = max(person(uv), smoothstep(0.5 * R, 0.3 * R, r)) * (1.0 - step(0.5, drop));
    col = mix(col, cam(uv), front);
    // The fingertips glow through, and the arms' bones as a fine line.
    float tips = 0.0;
    for (int s = 0; s < 2; s++) {
        if (!handOn(s)) continue;
        for (int i = 4; i < 21; i += 4) tips += exp(-pow(length(p - scr(handPt(s, i))) / (0.008 + 0.006 * pulse), 2.0));
    }
    col = mix(col, uPal2.rgb, clamp(tips + 0.5 * (1.0 - smoothstep(0.0, 0.003, bones(uv))), 0.0, 1.0));
    fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
