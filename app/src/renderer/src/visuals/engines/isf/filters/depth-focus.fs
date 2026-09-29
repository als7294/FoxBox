/*{
  "DESCRIPTION": "Depth focus: what is near the camera (S1's near mask) stays sharp while the rest falls out of focus. The focus racks further out through a build, snaps sharp on the drop, and breathes with the sub. Without a mask it holds a soft centre focus.",
  "CREDIT": "FoxBox (original filter, MIT)",
  "ISFVSN": "2",
  "CATEGORIES": [
    "FoxBox",
    "Filter",
    "Smart"
  ],
  "INPUTS": [
    {
      "NAME": "inputImage",
      "TYPE": "image"
    }
  ]
}*/

// How near a point is, 0 (far) to 1 (near): the mask's coverage (softened at its edge), else a centre ellipse.
float nearAt(vec2 uv) {
  if (hasDepth < 0.5) {
    vec2 d = (uv - 0.5) * vec2(RENDERSIZE.x / RENDERSIZE.y, 1.0);
    return 1.0 - smoothstep(0.16, 0.42, length(d));
  }
  vec2 e = 3.0 / RENDERSIZE;
  float m = IMG_NORM_PIXEL(depthMask, uv).a * 0.4;
  vec2 a = uv + vec2(e.x, 0.0);
  vec2 b = uv - vec2(e.x, 0.0);
  vec2 c = uv + vec2(0.0, e.y);
  vec2 d = uv - vec2(0.0, e.y);
  m += (IMG_NORM_PIXEL(depthMask, a).a + IMG_NORM_PIXEL(depthMask, b).a + IMG_NORM_PIXEL(depthMask, c).a
    + IMG_NORM_PIXEL(depthMask, d).a) * 0.15;
  return smoothstep(0.1, 0.9, m);
}

void main() {
  vec2 uv = isf_FragNormCoord;
  float near = nearAt(uv);
  // Blur radius as a fraction of the height: deeper through a build, a breath on the sub, sharp at the hit.
  float r = (0.004 + 0.012 * buildProgress + 0.004 * bassSub * bassOn) * (1.0 - 0.9 * dropHit) * (1.0 - 0.5 * calm);
  r *= 1.0 - near;
  vec4 sum = IMG_NORM_PIXEL(inputImage, uv);
  float wsum = 1.0;
  vec2 aspect = vec2(RENDERSIZE.y / RENDERSIZE.x, 1.0);
  // A 24-tap golden-angle disc.
  for (int i = 1; i < 25; i++) {
    float fi = float(i);
    float ang = fi * 2.39996;
    vec2 p = uv + vec2(cos(ang), sin(ang)) * aspect * r * sqrt(fi / 24.0);
    sum += IMG_NORM_PIXEL(inputImage, p);
    wsum += 1.0;
  }
  vec4 col = sum / wsum;
  // The far plane dims a touch as the focus racks out, so the near subject reads first.
  col.rgb *= 1.0 - 0.25 * (1.0 - near) * buildProgress;
  gl_FragColor = vec4(col.rgb, 1.0);
}
