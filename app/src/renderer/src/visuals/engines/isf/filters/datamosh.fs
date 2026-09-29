/*{
  "DESCRIPTION": "Blocks hold on to the previous frames and drift, more of them on each hit (a datamosh look).",
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
      "NAME": "onset",
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
      "TARGET": "prev",
      "PERSISTENT": true
    },
    {}
  ]
}*/

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
// WebGL can't read a texture while drawing into it: pass 0 draws into `next` from `prev`, pass 1 copies it back.
void main() {
  vec2 uv = isf_FragNormCoord;
  if (PASSINDEX == 0) {
    vec2 cell = floor(uv * vec2(24.0, 14.0));
    float h = hash(cell + floor(TIME * 8.0));
    float mosh = step(1.0 - clamp(onset * 0.6 + rms * 0.25 + buildProgress * 0.2 + dropHit * 0.6, 0.0, 0.9) * (1.0 - 0.7 * calm), h);
    vec2 pu = uv + (vec2(hash(cell + 1.3), hash(cell + 7.1)) - 0.5) * 0.012;
    gl_FragColor = mix(IMG_NORM_PIXEL(inputImage, uv), IMG_NORM_PIXEL(prev, pu), mosh * 0.96);
  } else {
    gl_FragColor = IMG_NORM_PIXEL(next, uv);
  }
}
