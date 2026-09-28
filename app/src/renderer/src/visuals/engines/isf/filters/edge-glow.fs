/*{
  "DESCRIPTION": "Outlines glow in the accent colour over a darkened picture; brighter on hits.",
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
      "NAME": "accentColor",
      "TYPE": "color",
      "DEFAULT": [
        1.0,
        0.294,
        0.169,
        1
      ]
    },
    {
      "NAME": "amberColor",
      "TYPE": "color",
      "DEFAULT": [
        1.0,
        0.698,
        0.243,
        1
      ]
    }
  ]
}*/

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float L(vec2 o) { vec2 q = isf_FragNormCoord + o / RENDERSIZE; return luma(IMG_NORM_PIXEL(inputImage, q).rgb); }
void main() {
  float gx = -L(vec2(-1.0, 1.0)) - 2.0 * L(vec2(-1.0, 0.0)) - L(vec2(-1.0, -1.0)) + L(vec2(1.0, 1.0)) + 2.0 * L(vec2(1.0, 0.0)) + L(vec2(1.0, -1.0));
  float gy = -L(vec2(-1.0, -1.0)) - 2.0 * L(vec2(0.0, -1.0)) - L(vec2(1.0, -1.0)) + L(vec2(-1.0, 1.0)) + 2.0 * L(vec2(0.0, 1.0)) + L(vec2(1.0, 1.0));
  float e = clamp(length(vec2(gx, gy)) * (1.2 + 2.0 * rms + 1.5 * onset), 0.0, 1.0);
  vec2 uv = isf_FragNormCoord;
  vec3 base = IMG_NORM_PIXEL(inputImage, uv).rgb * 0.35;
  gl_FragColor = vec4(base + mix(accentColor.rgb, amberColor.rgb, e) * e, 1.0);
}
