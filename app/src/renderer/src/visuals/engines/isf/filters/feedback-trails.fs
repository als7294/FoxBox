/*{
  "DESCRIPTION": "Echoing trails: each frame keeps a slowly zooming, fading copy of the last, longer with the level.",
  "CREDIT": "FoxBox (original filter, MIT)",
  "ISFVSN": "2",
  "CATEGORIES": [
    "FoxBox",
    "Filter"
  ],
  "INPUTS": [
    {
      "NAME": "inputImage",
      "TYPE": "image"
    },
    {
      "NAME": "rms",
      "TYPE": "float",
      "DEFAULT": 0
    },
    {
      "NAME": "beatPhase",
      "TYPE": "float",
      "DEFAULT": 0
    },
    {
      "NAME": "calm",
      "TYPE": "float",
      "DEFAULT": 0
    }
  ],
  "PASSES": [
    {
      "TARGET": "next",
      "PERSISTENT": true
    },
    {
      "TARGET": "trail",
      "PERSISTENT": true
    },
    {}
  ]
}*/

// WebGL can't read a texture while drawing into it, so pass 0 draws the new trail into `next` from the last one
// (`trail`), and pass 1 copies it back for the next frame.
void main() {
  vec2 uv = isf_FragNormCoord;
  if (PASSINDEX == 0) {
    float z = 1.0 - (0.006 + 0.01 * (1.0 - beatPhase)) * (1.0 - 0.6 * calm);
    float a = 0.004 * sin(TIME * 0.3);
    vec2 p = (uv - 0.5) * z;
    vec2 q = vec2(p.x * cos(a) - p.y * sin(a), p.x * sin(a) + p.y * cos(a)) + 0.5;
    vec4 old = IMG_NORM_PIXEL(trail, q) * min(0.86 + 0.1 * rms + 0.06 * bassHold * bassOn + 0.05 * dropEnergy, 0.97);  // held subs and drops stretch the trails
    gl_FragColor = max(IMG_NORM_PIXEL(inputImage, uv), old);
  } else {
    gl_FragColor = IMG_NORM_PIXEL(next, uv);
  }
}
