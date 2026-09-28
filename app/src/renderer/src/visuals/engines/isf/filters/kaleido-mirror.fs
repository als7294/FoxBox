/*{
  "DESCRIPTION": "Mirrors the picture into a kaleidoscope; the highs add segments.",
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
      "NAME": "high",
      "TYPE": "float",
      "DEFAULT": 0
    },
    {
      "NAME": "rms",
      "TYPE": "float",
      "DEFAULT": 0
    }
  ]
}*/

void main() {
  vec2 p = isf_FragNormCoord - 0.5;
  p.x *= RENDERSIZE.x / RENDERSIZE.y;
  float seg = 6.0 + floor(high * 4.0) * 2.0;
  float k = 6.28318 / seg;
  float a = atan(p.y, p.x) + TIME * 0.05;
  a = abs(mod(a, k) - 0.5 * k);
  float r = length(p) * (1.0 - 0.15 * rms);
  vec2 q = vec2(cos(a), sin(a)) * r;
  q.x *= RENDERSIZE.y / RENDERSIZE.x;
  vec2 uv = clamp(q + 0.5, 0.0, 1.0);
  gl_FragColor = IMG_NORM_PIXEL(inputImage, uv);
}
