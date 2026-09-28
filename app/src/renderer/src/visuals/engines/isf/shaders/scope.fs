/*{
  "DESCRIPTION": "A CRT trace of the spectrum over soft scanlines.",
  "CREDIT": "FoxBox (original shader, MIT)",
  "ISFVSN": "2",
  "CATEGORIES": [
    "FoxBox"
  ],
  "INPUTS": [
    {
      "NAME": "rms",
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
      "NAME": "inkColor",
      "TYPE": "color",
      "DEFAULT": [
        0.914,
        0.898,
        0.855,
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
  float s = spec(uv.x * 0.7);
  float y = 0.5 + (s - 0.25) * 0.6;
  float d = abs(uv.y - y);
  float trace = smoothstep(0.006, 0.0, d) + 0.004 / (d + 0.004) * 0.2;
  float scan = 0.85 + 0.15 * sin(uv.y * RENDERSIZE.y * 1.4);
  vec2 v = uv - 0.5;
  float vignette = 1.0 - dot(v, v) * 1.6;
  vec3 c = (bgColor.rgb + accentColor.rgb * trace * (0.7 + rms) + inkColor.rgb * 0.02) * scan * vignette;
  gl_FragColor = vec4(c, 1.0);
}
