// AIR DRAW: pinch to draw with your index fingertip (either hand); the strokes stay a few seconds, an open palm wipes
// them away. No hands seen: a wrist raised above its shoulder draws instead. The strokes' colours turn on the kick
// (REACTS TO). Drop: the brush gets wider. The camera stays dim behind, your skeleton faintly traced.

void main() {
    vec2 uv = vUV.st;
    vec2 p = scr(uv);
    float pulse = uReact.x, drop = uAudio.z, t = uAudio.w;
    float brush = uMacro.x, stay = uMacro.y;

    // The strokes so far: bright ink stays (STAY), the dim camera behind it fades fast; an open palm (the recognizer's
    // sign) wipes, unless the other hand is drawing.
    vec3 old = prev(uv).rgb;
    bool drawing = (handOn(0) && uShapeL.x >= 0.6) || (handOn(1) && uShapeR.x >= 0.6);
    bool wipe = !drawing && ((handOn(0) && uHand.z > 1.5 && uHand.z < 2.5) || (handOn(1) && uHand.w > 1.5 && uHand.w < 2.5));
    float ink = max(old.r, max(old.g, old.b));
    float keep = ink > 0.3 ? (wipe ? 0.9 : mix(0.99, 0.9985, stay)) : 0.75;
    old = max(old * keep - 1.0 / 255.0, 0.0);
    old = mix(old, old.gbr, 0.25 * pulse * step(0.3, ink)); // the colours turn on the kick (no brighter)

    // The brush: each pinching hand's index tip, else a raised wrist.
    float r = 0.011 * mix(0.6, 1.8, brush) * (1.0 + step(0.5, drop));
    vec3 paint = vec3(0.0);
    for (int s = 0; s < 2; s++) {
        float pinch = s == 0 ? uShapeL.x : uShapeR.x;
        if (!handOn(s) || pinch < 0.6) continue;
        float d = length(p - scr(handPt(s, 8)));
        paint = max(paint, mix(uPal1.rgb, uPal2.rgb, fract(t * 0.07 + 0.5 * float(s))) * smoothstep(r, 0.5 * r, d));
    }
    if (!handOn(0) && !handOn(1)) {
        for (int i = 0; i < 2; i++) {
            int wr = 15 + i, sh = 11 + i;
            if (!jointOn(wr) || !jointOn(sh) || joint(wr).y < joint(sh).y) continue;
            float d = length(p - scr(joint(wr)));
            paint = max(paint, uPal1.rgb * smoothstep(1.5 * r, 0.75 * r, d));
        }
    }
    vec3 scene = cam(uv) * 0.2 + uPal3.rgb * 0.25 * (1.0 - smoothstep(0.0, 0.003, min(bones(uv), fingers(uv))));
    fragColor = TDOutputSwizzle(vec4(max(max(scene, old), paint), 1.0));
}
