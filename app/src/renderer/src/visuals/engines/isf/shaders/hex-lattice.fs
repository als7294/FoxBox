/*{
  "DESCRIPTION": "A hexagon lattice, each ring of cells lit by its part of the spectrum.",
  "CREDIT": "FoxBox (original shader, MIT)",
  "ISFVSN": "2",
  "CATEGORIES": [
    "FoxBox"
  ],
  "INPUTS": [
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
float hexDist(vec2 p) { p = abs(p); return max(dot(p, normalize(vec2(1.0, 1.73))), p.x); }
void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * RENDERSIZE) / min(RENDERSIZE.x, RENDERSIZE.y) * 9.0;
  vec2 r = vec2(1.0, 1.73);
  vec2 h = r * 0.5;
  vec2 a = mod(p, r) - h, b = mod(p - h, r) - h;
  vec2 g = dot(a, a) < dot(b, b) ? a : b;
  vec2 id = p - g;
  float ring = length(id) / 9.0;
  float s = spec(ring * 0.6);
  float edge = smoothstep(0.02, 0.06, 0.5 - hexDist(g));
  vec3 col = mix(accentColor.rgb, amberColor.rgb, s) * s * edge;
  col += inkColor.rgb * onset * 0.2 * edge * step(0.6, s);
  gl_FragColor = vec4(bgColor.rgb + col, 1.0);
}
