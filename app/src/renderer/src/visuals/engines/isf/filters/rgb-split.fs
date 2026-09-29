/*{
  "DESCRIPTION": "Splits red and blue apart; wider on each hit.",
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

void main() {
  vec2 uv = isf_FragNormCoord;
  float amt = (0.002 + 0.022 * onset + 0.01 * rms + 0.012 * buildProgress + 0.03 * dropHit + 0.01 * bassGrowl * bassOn) * (1.0 - 0.6 * calm);
  vec2 dir = vec2(cos(TIME * 0.7), sin(TIME * 0.7)) * amt;
  vec2 ur = uv + dir;
  vec2 ub = uv - dir;
  vec4 g = IMG_NORM_PIXEL(inputImage, uv);
  gl_FragColor = vec4(IMG_NORM_PIXEL(inputImage, ur).r, g.g, IMG_NORM_PIXEL(inputImage, ub).b, 1.0);
}
