/*{
  "DESCRIPTION": "A ring drawn by the spectrum around the centre; it swells with the lows.",
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
  vec2 p = (gl_FragCoord.xy - 0.5 * RENDERSIZE) / min(RENDERSIZE.x, RENDERSIZE.y);
  float a = atan(p.y, p.x) / 6.28318 + 0.5;
  float r = length(p);
  float s = spec(abs(a - 0.5) * 1.2);
  float radius = 0.22 + 0.08 * low + 0.18 * s;
  float line = smoothstep(0.012, 0.0, abs(r - radius));
  float glow = 0.02 / (abs(r - radius) + 0.02) * (0.3 + onset);
  vec3 c = bgColor.rgb + accentColor.rgb * (line + 0.25 * glow) + inkColor.rgb * 0.5 * line * s;
  gl_FragColor = vec4(c, 1.0);
}
