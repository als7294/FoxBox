/*{
  "DESCRIPTION": "Scanlines that tear into displaced blocks on each onset.",
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
      "NAME": "iceColor",
      "TYPE": "color",
      "DEFAULT": [
        0.486,
        0.784,
        1.0,
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
    }
  ]
}*/

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 uv = isf_FragNormCoord;
  vec2 block = floor(uv * vec2(16.0, 24.0));
  float tear = step(1.0 - onset * 0.6, hash(block + floor(TIME * 12.0)));
  uv.x += (hash(block.yy + floor(TIME * 20.0)) - 0.5) * 0.2 * tear;
  float scan = 0.5 + 0.5 * sin(uv.y * RENDERSIZE.y * 1.2);
  float band = smoothstep(0.02, 0.0, abs(fract(uv.y - TIME * 0.1) - 0.5) - 0.02);
  vec3 c = bgColor.rgb + accentColor.rgb * band * (0.3 + rms) + iceColor.rgb * tear * 0.35;
  c = mix(c, c * scan, 0.35) + inkColor.rgb * 0.04 * step(0.5, fract(uv.x * 40.0 + TIME));
  gl_FragColor = vec4(c, 1.0);
}
