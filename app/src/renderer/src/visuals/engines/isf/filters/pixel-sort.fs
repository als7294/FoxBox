/*{
  "DESCRIPTION": "Bright pixels melt upwards in streaks, longer with the level (a pixel-sort look).",
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
  ]
}*/

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
  vec2 uv = isf_FragNormCoord;
  vec4 best = IMG_NORM_PIXEL(inputImage, uv);
  float bl = luma(best.rgb);
  float len = (0.02 + 0.25 * rms + 0.2 * onset) * (1.0 - 0.6 * calm);
  for (int i = 1; i <= 24; i++) {
    vec2 q = uv - vec2(0.0, len * float(i) / 24.0);
    vec4 c = IMG_NORM_PIXEL(inputImage, q);
    float l = luma(c.rgb);
    if (l > bl && l > 0.55) { best = c; bl = l; }
  }
  gl_FragColor = best;
}
