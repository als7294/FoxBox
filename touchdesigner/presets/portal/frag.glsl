// PORTAL: make a FRAME with your thumbs and index fingers and another world shows inside it: THRESHOLD (black, white
// and red), X-RAY (the picture inverted, your skeleton and hands' bones glowing through) or KALEIDO (the picture
// mirrored round the frame's centre), by WORLD; a drop always opens the kaleido. The portal fades in and out (never
// pops), its rim pulses with REACTS TO. Without a frame: the camera, your arms' bones faintly traced.

// Signed distance to the FRAME's quad (screen heights): < 0 inside.
float quad(vec2 p) {
    float d = -1e3;
    float turn = 0.0; // the corners' winding, so inside is inside either way round
    for (int i = 0; i < 4; i++) {
        vec2 a = scr(frameCorner(i)), b = scr(frameCorner((i + 1) % 4)), c = scr(frameCorner((i + 2) % 4));
        turn += (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    }
    for (int i = 0; i < 4; i++) {
        vec2 a = scr(frameCorner(i)), b = scr(frameCorner((i + 1) % 4));
        vec2 e = normalize(b - a);
        float side = (e.x * (p.y - a.y) - e.y * (p.x - a.x)) * sign(turn);
        d = max(d, -side);
    }
    return d;
}

void main() {
    vec2 res = uTDOutputInfo.res.zw;
    vec2 uv = vUV.st;
    vec2 p = scr(uv);
    float pulse = uReact.x, drop = uAudio.z;
    float world = uMacro.x, rim = uMacro.y;

    vec3 outside = cam(uv);
    outside = mix(outside, vec3(dot(outside, vec3(0.2126, 0.7152, 0.0722))), 0.35);
    outside += uPal2.rgb * 0.35 * (1.0 - smoothstep(0.0, 0.003, bones(uv)));

    // The open amount: the held flag eased by the feed, so the portal fades over ~150 ms.
    float open = uShape.w;
    vec3 col = outside;
    if (open > 0.001 && uFrame[0].x >= 0.0) {
        float d = quad(p);
        float inside = smoothstep(0.004, -0.004, d) * open;
        // The other world, full frame.
        vec2 fc = 0.25 * (scr(frameCorner(0)) + scr(frameCorner(1)) + scr(frameCorner(2)) + scr(frameCorner(3)));
        float mode = drop > 0.5 ? 2.0 : floor(world * 2.99);
        vec3 c = cam(uv);
        float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
        vec3 other;
        if (mode < 0.5) {
            other = lum < 0.33 ? uPal0.rgb : lum < 0.6 ? uPal1.rgb : uPal2.rgb;
        } else if (mode < 1.5) {
            other = (vec3(1.0) - c) * vec3(0.35, 0.6, 0.75);
            other += uPal2.rgb * (1.0 - smoothstep(0.0, 0.006, min(bones(uv), fingers(uv))));
        } else {
            vec2 q = p - fc;
            float n = 6.0;
            float a = abs(mod(atan(q.y, q.x), 6.28318 / n) - 3.14159 / n);
            vec2 m = fc + vec2(cos(a), sin(a)) * length(q) * 1.4;
            other = cam(m / vec2(res.x / res.y, 1.0));
            other = mix(other, other * uPal1.rgb * 1.5, 0.35);
        }
        col = mix(outside, other, inside);
        // The rim: a glow round the edge, pulsing.
        float edge = exp(-pow(d / (0.003 + 0.004 * pulse * rim), 2.0)) * open;
        col = mix(col, uPal1.rgb, clamp(edge * (0.6 + rim), 0.0, 1.0));
    }
    fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
