// POINT CLOUD: the picture as rows of dots, each lifted by its brightness (the person most), so the body stands up out of
// the grid like a relief. The hands are force fields: the dots under them leap up, swell and light in the hot colour;
// the skeleton runs through the cloud as a ridge. REACTS TO: the dots swell and jump. Snare: rows slip sideways.
// Drop: the person's dots go to the hot colour.

void main() {
    vec2 res = uTDOutputInfo.res.zw;
    float aspect = res.x / res.y;
    vec2 uv = vUV.st;
    float pulse = uReact.x, snare = uAudio.y, drop = uAudio.z;
    float density = uMacro.x, lift = uMacro.y, size = uMacro.z;

    float nx = floor(mix(48.0, 160.0, density));
    float ny = floor(nx / aspect);
    float maxLift = (0.07 + 0.1 * lift) * (1.0 + 0.6 * pulse); // in uv (the hands' lift included)
    // The hands' fields: each palm and index tip.
    vec2 field[4];
    int nf = 0;
    for (int s = 0; s < 2; s++) {
        if (!handOn(s)) continue;
        field[nf++] = scr(handPt(s, 9));
        field[nf++] = scr(handPt(s, 8));
    }
    float col = floor(uv.x * nx);
    float row0 = floor(uv.y * ny);
    vec3 outc = uPal0.rgb;
    // The dots whose lift can reach this pixel: this row's and the rows below (drawn after: nearer, on top).
    for (int k = 0; k < 32; k++) {
        float r = row0 - float(k);
        if (r < 0.0 || float(k) > maxLift * ny + 1.0) break;
        float slip = floor((hash(vec2(r, uGrid.w)) - 0.5) * 6.0 * snare);
        vec2 b = vec2((col + 0.5) / nx, (r + 0.5) / ny);
        vec2 src = vec2((col + slip + 0.5) / nx, b.y);
        vec3 c = cam(src);
        float who = person(src);
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722)) * mix(0.3, 1.0, who); // the room recedes, the person stands up
        float force = 0.0;
        for (int f = 0; f < 4; f++) if (f < nf) force += exp(-pow(length(scr(b) - field[f]) / 0.09, 2.0));
        force = min(force, 1.0);
        float ridge = 1.0 - smoothstep(0.0, 0.025, bones(b));
        float up = (0.35 * l + 0.65 * who) * (0.04 + 0.1 * lift) + 0.025 * force + 0.02 * ridge;
        vec2 d = (uv - b - vec2(0.0, up * (1.0 + 0.6 * pulse))) * vec2(aspect, 1.0);
        float rad = (0.12 + 0.3 * l * (0.5 + size) + 0.3 * force) * (1.0 + 0.4 * pulse) / ny;
        if (length(d) < rad) {
            vec3 tone = mix(uPal3.rgb, uPal1.rgb, clamp(l + 0.4 * who + 0.5 * ridge + force, 0.0, 1.0));
            outc = mix(tone, uPal2.rgb, max(smoothstep(0.3, 0.8, drop) * who, force));
        }
    }
    // The tracked points, ringed.
    vec2 p = uv * vec2(aspect, 1.0);
    float px = 1.0 / res.y;
    float ring = 0.0;
    for (int i = 0; i < 32; i++) {
        if (uPts[i].x < 0.0) continue;
        float d = length(p - ptToUV(uPts[i]) * vec2(aspect, 1.0));
        ring += 1.0 - smoothstep(0.0, 1.5 * px, abs(d - (5.0 + 8.0 * pulse) * px));
    }
    fragColor = TDOutputSwizzle(vec4(mix(outc, uPal2.rgb, clamp(ring, 0.0, 1.0)), 1.0));
}
