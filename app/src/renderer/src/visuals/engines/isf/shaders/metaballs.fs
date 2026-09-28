/*{
  "DESCRIPTION": "Five blobs orbiting and merging; the bands size them.",
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
      "NAME": "mid",
      "TYPE": "float",
      "DEFAULT": 0
    },
    {
      "NAME": "high",
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
    }
  ]
}*/

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * RENDERSIZE) / min(RENDERSIZE.x, RENDERSIZE.y);
  float f = 0.0;
  for (int i = 0; i < 5; i++) {
    float fi = float(i);
    vec2 c = 0.28 * vec2(cos(TIME * (0.3 + 0.1 * fi) + fi * 1.3), sin(TIME * (0.4 + 0.07 * fi) + fi * 2.1));
    float r = 0.05 + 0.06 * (fi < 2.0 ? low : fi < 4.0 ? mid : high);
    f += r * r / dot(p - c, p - c);
  }
  float inside = smoothstep(0.9, 1.1, f);
  vec3 col = mix(accentColor.rgb, amberColor.rgb, clamp(f - 1.0, 0.0, 1.0));
  gl_FragColor = vec4(mix(bgColor.rgb, col, inside) + accentColor.rgb * 0.08 * f, 1.0);
}
