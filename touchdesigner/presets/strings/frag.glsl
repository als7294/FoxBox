// STRINGS: glowing strings between your fingertips, like a cat's cradle: each tip to the same tip of the other hand,
// and four crossing between them. They hum with the bass (REACTS TO, the low band) and are plucked by the snare (a
// higher harmonic that rings off). One hand: its tips string to the far shoulder. No hands: the arms are the strings.
// Drop: the strings turn hot and double their swing.

// The glow of a string from a to b (screen heights), swung sideways by a standing wave.
float strand(vec2 p, vec2 a, vec2 b, float amp, float pluck, float t, float k) {
    vec2 ab = b - a;
    float l = length(ab);
    if (l < 1e-3) return 0.0;
    vec2 dir = ab / l, nrm = vec2(-dir.y, dir.x);
    float s = dot(p - a, dir) / l;
    if (s < 0.0 || s > 1.0) return 0.0;
    float off = amp * sin(3.14159 * s) * sin(t * 40.0 + k) + pluck * sin(3.0 * 3.14159 * s) * sin(t * 90.0 + 2.0 * k);
    float d = abs(dot(p - a, nrm) - off * l);
    return exp(-pow(d / 0.0018, 2.0)) + 0.35 * exp(-d / 0.008);
}

void main() {
    vec2 uv = vUV.st;
    vec2 p = scr(uv);
    float bass = uReact.x, snare = uAudio.y, drop = uAudio.z, t = uAudio.w;
    float swing = uMacro.x, glow = uMacro.y, crossing = uMacro.z;

    float amp = (0.004 + 0.035 * bass * swing) * (1.0 + step(0.5, drop));
    float pluck = 0.025 * snare;
    vec3 col = cam(uv) * mix(0.2, 0.45, person(uv));
    float g = 0.0;
    vec3 tint = vec3(0.0);
    bool l = handOn(0), r = handOn(1);
    for (int i = 0; i < 5; i++) {
        int tip = 4 + 4 * i;
        vec3 c = mix(uPal1.rgb, uPal2.rgb, float(i) / 4.0);
        float s = 0.0;
        if (l && r) {
            s = strand(p, scr(handPt(0, tip)), scr(handPt(1, tip)), amp, pluck, t, float(i));
            if (i < 4) s += crossing * strand(p, scr(handPt(0, tip)), scr(handPt(1, tip + 4)), amp, pluck, t, float(i) + 7.0);
        } else if (l || r) {
            int side = l ? 0 : 1;
            int shoulder = side == 0 ? 12 : 11; // the far one
            if (jointOn(shoulder)) s = strand(p, scr(handPt(side, tip)), scr(joint(shoulder)), amp, pluck, t, float(i));
        }
        g += s;
        tint += c * s;
    }
    if (!l && !r) {
        // The arms: shoulder to wrist, each a string.
        for (int a = 0; a < 2; a++) {
            int sh = 11 + a, wr = 15 + a;
            if (!jointOn(sh) || !jointOn(wr)) continue;
            float s = strand(p, scr(joint(sh)), scr(joint(wr)), amp, pluck, t, float(a) * 3.0);
            g += s;
            tint += uPal1.rgb * s;
        }
    }
    vec3 hot = mix(vec3(1.0), uPal3.rgb, smoothstep(0.3, 0.8, drop));
    col += (tint * mix(0.6, 1.4, glow)) + hot * 0.4 * clamp(g, 0.0, 1.0) * glow;
    // The fingertips: small bright beads where the strings tie on.
    float beads = 0.0;
    for (int s = 0; s < 2; s++) {
        if (!handOn(s)) continue;
        for (int i = 4; i < 21; i += 4) beads += exp(-pow(length(p - scr(handPt(s, i))) / 0.006, 2.0));
    }
    col = mix(col, hot, clamp(beads, 0.0, 1.0));
    fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
