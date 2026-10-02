// ASCII BODY: the camera as glyphs, denser where it's brighter, the person white over a dim room; the skeleton and the
// hands' bones written in solid glyphs in the hot colour, and round each hand the glyphs scramble like static. REACTS
// TO: more of the person lights up. Snare: a band of glyphs scrambles. Drop: digits rain down the person (RAIN).

const int GLYPHS[10] = int[10](0, 4, 131200, 14336, 1016800, 4357252, 22511061, 11512810, 27070835, 15261199); // " .:-=+*#%@", 5x5

// A 5x5 glyph's pixel: g 0-4 across, 0-4 up.
float glyph(int bits, vec2 g) {
    ivec2 i = ivec2(g);
    return float((bits >> (i.y * 5 + (4 - i.x))) & 1);
}

void main() {
    vec2 res = uTDOutputInfo.res.zw;
    float aspect = res.x / res.y;
    vec2 uv = vUV.st;
    float pulse = uReact.x, snare = uAudio.y, drop = uAudio.z, t = uAudio.w;
    float size = uMacro.x, gain = uMacro.y, rain = uMacro.z;

    // The cell: a glyph of 5 and a gap of 1, in units of cs / 6 px.
    float cs = floor(mix(8.0, 22.0, size));
    vec2 id = floor(uv * res / cs);
    vec2 g = fract(uv * res / cs) * 6.0;
    vec2 cuv = (id + 0.5) * cs / res;
    vec3 c = cam(cuv);
    float who = person(cuv);
    float lv = clamp(dot(c, vec3(0.2126, 0.7152, 0.0722)) * mix(0.5, 1.0, who) * (0.7 + gain) + 0.3 * pulse * who, 0.0, 0.999);
    int k = int(lv * 10.0);
    // The snare scrambles a band of rows.
    float band = hash(vec2(uGrid.w, 3.0));
    if (abs(cuv.y - band) < 0.1 * snare) k = int(hash(id + floor(t * 20.0)) * 9.99);
    // The hands scramble the glyphs round them; the skeleton is drawn in the densest glyph.
    float cell = cs / res.y;
    float nearH = 1.0 - smoothstep(2.0 * cell, 6.0 * cell, nearestHand(cuv).x);
    if (hash(id + floor(t * 15.0) + 3.0) < nearH) k = int(hash(id * 1.7 + floor(t * 15.0)) * 9.99);
    float skel = 1.0 - step(0.8 * cell, min(bones(cuv), fingers(cuv)));
    if (skel > 0.0) k = 9;
    float on = g.x < 5.0 && g.y < 5.0 ? glyph(GLYPHS[k], g) : 0.0;
    vec3 col = mix(uPal0.rgb, mix(uPal3.rgb, uPal1.rgb, max(who, nearH)) * (0.4 + 0.6 * max(lv, nearH)), on);
    col = mix(col, uPal2.rgb, skel * on);

    // A drop: digits rain down the person, each column at its own speed.
    float rainy = smoothstep(0.3, 0.7, drop) * rain * who;
    if (rainy > 0.0) {
        float sp = 0.3 + 0.7 * hash(vec2(id.x, 1.0));
        float head = 1.0 - fract(t * sp * 0.5 + hash(vec2(id.x, 2.0)));
        float tail = cuv.y >= head ? exp(-(cuv.y - head) * 6.0) : 0.0;
        float d = digit(int(hash(id + floor(t * 6.0)) * 9.99), vec2((g.x - 1.0) / 3.6, g.y / 6.0));
        col = mix(col, uPal2.rgb, clamp(d * tail * rainy * 1.5, 0.0, 1.0));
    }
    // The tracked points: their cells in the hot colour.
    float near = 0.0;
    for (int i = 0; i < 32; i++) {
        if (uPts[i].x < 0.0) continue;
        vec2 d = (cuv - ptToUV(uPts[i])) * res / cs;
        near = max(near, 1.0 - smoothstep(0.6, 1.6, length(d)));
    }
    col = mix(col, uPal2.rgb, near * max(on, 0.35));
    fragColor = TDOutputSwizzle(vec4(col, 1.0));
}
