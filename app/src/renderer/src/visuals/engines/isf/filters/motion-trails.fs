/*{
  "DESCRIPTION": "Motion trails: only what moves leaves a trail (the frame-to-frame difference), in the palette's accent. A held sub or a drop stretches the trails; a build draws them outward.",
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
  ],
  "PASSES": [
    {
      "TARGET": "next",
      "PERSISTENT": true,
      "FLOAT": true
    },
    {
      "TARGET": "trail",
      "PERSISTENT": true,
      "FLOAT": true
    },
    {
      "TARGET": "prev",
      "PERSISTENT": true
    },
    {}
  ]
}*/

// Pass 0: the new trail (in `next`) from the last (`trail`) and what moved since the last frame (`prev`).
// Pass 1: copy it back into `trail`; pass 2: keep this frame in `prev` (WebGL can't read a texture it draws into).
// Pass 3: the picture with its trails.
void main() {
  vec2 uv = isf_FragNormCoord;
  vec4 cur = IMG_NORM_PIXEL(inputImage, uv);
  if (PASSINDEX == 0) {
    vec4 was = IMG_NORM_PIXEL(prev, uv);
    float moved = smoothstep(0.05, 0.22, length(cur.rgb - was.rgb));
    vec2 q = (uv - 0.5) * (1.0 - 0.006 * buildProgress * (1.0 - calm)) + 0.5;
    float keep = 0.86 + 0.08 * bassHold * bassOn + 0.05 * dropEnergy;
    keep = min(keep, 0.97) * (1.0 - 0.1 * calm);
    vec3 old = IMG_NORM_PIXEL(trail, q).rgb * keep;
    gl_FragColor = vec4(max(old, cur.rgb * moved), 1.0);
  } else if (PASSINDEX == 1) {
    gl_FragColor = IMG_NORM_PIXEL(next, uv);
  } else if (PASSINDEX == 2) {
    gl_FragColor = cur;
  } else {
    vec3 t = IMG_NORM_PIXEL(next, uv).rgb;
    vec3 tint = mix(accentColor.rgb, iceColor.rgb, 0.5 + 0.5 * sin(TIME * 0.4));
    float lum = dot(t, vec3(0.299, 0.587, 0.114));
    gl_FragColor = vec4(cur.rgb + tint * lum * (0.9 + 0.6 * dropEnergy), 1.0);
  }
}
