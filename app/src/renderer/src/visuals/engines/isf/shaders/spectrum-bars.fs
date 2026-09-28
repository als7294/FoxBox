/*{
  "DESCRIPTION": "Mirrored spectrum bars from the centre, accent to amber.",
  "CREDIT": "FoxBox (original shader, MIT)",
  "ISFVSN": "2",
  "CATEGORIES": [
    "FoxBox"
  ],
  "INPUTS": [
    {
      "NAME": "low",
      "TYPE": "float",
      "DEFAULT": 0
    },
    {
      "NAME": "onset",
      "TYPE": "float",
      "DEFAULT": 0
    },
    {
      "NAME": "bgColor",
      "TYPE": "color",
      "DEFAULT": [
        0.043,
        0.043,
        0.047,
        1
      ]
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
    },
    {
      "NAME": "fft",
      "TYPE": "audioFFT"
    }
  ]
}*/

// IMG_NORM_PIXEL splits its arguments on commas: build the coordinate first.
float spec(float x) {
  vec2 q = vec2(clamp(x, 0.001, 0.999), 0.5);
  return IMG_NORM_PIXEL(fft, q).r;
}
void main() {
  vec2 uv = isf_FragNormCoord;
  float x = abs(uv.x - 0.5) * 2.0;
  float bins = 56.0;
  float i = floor(x * bins) / bins;
  float h = spec(pow(i, 1.7) * 0.65) * (0.9 + 0.25 * onset);
  float y = abs(uv.y - 0.5) * 2.0;
  float bar = step(y, h) * step(0.2, fract(x * bins));
  vec3 col = mix(accentColor.rgb, amberColor.rgb, clamp(y / max(h, 0.001), 0.0, 1.0));
  vec3 c = mix(bgColor.rgb, col, bar) + accentColor.rgb * 0.12 * low * (1.0 - y);
  gl_FragColor = vec4(c, 1.0);
}
