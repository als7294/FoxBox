// ENERGY BALL: a plasma orb held between your hands, as big as they are apart; pinch both to squeeze it (smaller,
// hotter, faster). Lightning jumps from it to your fingertips on the beat (once a beat at most). One hand: it floats
// above that palm. No hands: a small one hums at your chest. REACTS TO: the orb swells. Drop: it turns white-hot.

// Distance to a jagged bolt from a to b (screen heights): a straight line bent by noise, pinned at both ends.
float bolt(vec2 p, vec2 a, vec2 b, float seed, float t) {
    vec2 ab = b - a;
    float l = max(length(ab), 1e-4);
    vec2 dir = ab / l, nrm = vec2(-dir.y, dir.x);
    float s = clamp(dot(p - a, dir) / l, 0.0, 1.0);
    float off = (noise(vec2(s * 9.0 + seed, floor(t * 24.0))) - 0.5) * 0.05 * l * sin(3.14159 * s);
    return length(p - (a + ab * s + nrm * off));
}

void main() {
    vec2 uv = vUV.st;
    vec2 p = scr(uv);
    float pulse = uReact.x, drop = uAudio.z, t = uAudio.w;
    float size = uMacro.x, swirl = uMacro.y, bolts = uMacro.z;

    // Where it is and how big: between the palms, else above one, else at the chest (between the shoulders).
    bool l = handOn(0), r = handOn(1);
    float squeeze = l && r ? min(uShapeL.x, uShapeR.x) : 0.0;
    vec2 c = vec2(-10.0);
    float R = 0.0;
    if (l && r) {
        vec2 a = scr(handPt(0, 9)), b = scr(handPt(1, 9));
        c = 0.5 * (a + b);
        R = 0.32 * length(a - b);
    } else if (l || r) {
        int s = l ? 0 : 1;
        c = scr(handPt(s, 9)) + vec2(0.0, 0.09);
        R = 0.05;
    } else if (jointOn(11) && jointOn(12)) {
        c = 0.5 * (scr(joint(11)) + scr(joint(12))) - vec2(0.0, 0.06);
        R = 0.035;
    }
    R *= mix(0.7, 1.3, size) * (1.0 - 0.45 * squeeze) * (1.0 + 0.15 * pulse);

    // The room dims round it; the person stays faintly there.
    vec3 col = cam(uv) * mix(0.25, 0.5, person(uv));
    vec3 hot = mix(uPal1.rgb, uPal3.rgb, smoothstep(0.3, 0.8, drop));
    if (R > 0.0) {
        vec2 q = (p - c) / R;
        float d = length(q);
        float speed = mix(0.4, 1.6, swirl) * (1.0 + 2.0 * squeeze);
        float plasma = fbm(q * 2.5 + vec2(fbm(q * 1.7 - t * speed * 0.6), fbm(q * 1.7 + 4.0 + t * speed * 0.5)) * 2.0 - t * speed * 0.3);
        vec3 core = mix(uPal1.rgb, uPal2.rgb, smoothstep(0.35, 0.75, plasma));
        core = mix(core, hot, smoothstep(0.5, 0.0, d) * (0.4 + 0.6 * squeeze));
        float body = smoothstep(1.0, 0.85, d);
        col = mix(col, core * (0.8 + 0.6 * plasma), body);
        col += hot * (exp(-pow((d - 1.0) / 0.06, 2.0)) * 0.8 + exp(-max(d - 1.0, 0.0) * 3.0) * 0.25);

        // Lightning to the fingertips, on the beat.
        float flare = pow(1.0 - uGrid.y, 4.0) * bolts;
        if (flare > 0.01) {
            float b = 1e3;
            for (int s = 0; s < 2; s++) {
                if (!handOn(s)) continue;
                for (int i = 4; i < 21; i += 4) {
                    vec2 tip = scr(handPt(s, i));
                    b = min(b, bolt(p, c + normalize(tip - c) * R, tip, float(s * 21 + i), t));
                }
            }
            col += mix(uPal2.rgb, vec3(1.0), 0.5) * flare * (exp(-pow(b / 0.0025, 2.0)) + 0.35 * exp(-b / 0.012));
        }
    }
    // The arms carry a faint charge.
    col += uPal1.rgb * 0.25 * (1.0 - smoothstep(0.0, 0.006, bones(uv)));
    fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
