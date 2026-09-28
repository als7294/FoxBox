/*{
  "DESCRIPTION": "A slow palette plasma; the level speeds it up.",
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
      "NAME": "mid",
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
      "NAME": "iceColor",
      "TYPE": "color",
      "DEFAULT": [
        0.486,
        0.784,
        1.0,
        1
      ]
    }
  ]
}*/

void main() {
  vec2 p = gl_FragCoord.xy / min(RENDERSIZE.x, RENDERSIZE.y) * 3.0;
  float t = TIME * (0.25 + rms * 1.5);
  float v = sin(p.x + t) + sin(p.y * 1.3 - t * 0.7) + sin((p.x + p.y) * 0.7 + t * 1.3) + sin(length(p - 1.5) * 2.0 - t);
  v = 0.5 + 0.125 * v;
  vec3 col = mix(mix(accentColor.rgb, amberColor.rgb, smoothstep(0.3, 0.7, v)), iceColor.rgb, smoothstep(0.75, 1.0, v) * mid);
  gl_FragColor = vec4(mix(bgColor.rgb, col, 0.35 + 0.65 * v * (0.6 + rms)), 1.0);
}
