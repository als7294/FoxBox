/*{
  "DESCRIPTION": "A calm field until the drop, then a wide flash that fades over the bar.",
  "CREDIT": "FoxBox (original shader, MIT)",
  "ISFVSN": "2",
  "CATEGORIES": [
    "FoxBox"
  ],
  "INPUTS": [
    {
      "NAME": "drop",
      "TYPE": "float",
      "DEFAULT": 0
    },
    {
      "NAME": "onset",
      "TYPE": "float",
      "DEFAULT": 0
    },
    {
      "NAME": "barPhase",
      "TYPE": "float",
      "DEFAULT": 0
    },
    {
      "NAME": "calm",
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

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
void main() {
  vec2 uv = isf_FragNormCoord;
  float n = noise(uv * 6.0 + TIME * 0.2);
  float flash = max(drop * (1.0 - barPhase), onset * 0.5) * (1.0 - 0.7 * calm);
  vec3 col = mix(bgColor.rgb + accentColor.rgb * 0.06 * n, mix(accentColor.rgb, amberColor.rgb, n), clamp(flash, 0.0, 1.0));
  gl_FragColor = vec4(col, 1.0);
}
