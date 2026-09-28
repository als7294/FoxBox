/*{
  "DESCRIPTION": "Slow drifting fog lit from below by the lows.",
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
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int k = 0; k < 5; k++) { v += a * noise(p); p *= 2.03; a *= 0.5; }
  return v;
}
void main() {
  vec2 uv = isf_FragNormCoord;
  vec2 p = uv * vec2(RENDERSIZE.x / RENDERSIZE.y, 1.0) * 2.5;
  float n = fbm(p + vec2(TIME * 0.05, -TIME * 0.03) + fbm(p * 0.7 - TIME * 0.02));
  float lift = (1.0 - uv.y) * (0.35 + low * 1.2);
  vec3 col = mix(accentColor.rgb, amberColor.rgb, n * (0.5 + mid));
  gl_FragColor = vec4(mix(bgColor.rgb, col, clamp(n * lift, 0.0, 1.0)), 1.0);
}
