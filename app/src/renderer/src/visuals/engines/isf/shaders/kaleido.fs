/*{
  "DESCRIPTION": "Kaleidoscope of drifting noise; the highs add mirror segments.",
  "CREDIT": "FoxBox (original shader, MIT)",
  "ISFVSN": "2",
  "CATEGORIES": [
    "FoxBox"
  ],
  "INPUTS": [
    {
      "NAME": "high",
      "TYPE": "float",
      "DEFAULT": 0
    },
    {
      "NAME": "rms",
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
  vec2 p = (gl_FragCoord.xy - 0.5 * RENDERSIZE) / min(RENDERSIZE.x, RENDERSIZE.y);
  float seg = 6.0 + floor(high * 6.0) * 2.0 + floor(buildProgress * 4.0) * 2.0;  // more mirrors as it builds
  float a = atan(p.y, p.x);
  float r = length(p);
  float k = 6.28318 / seg;
  a = abs(mod(a, k) - 0.5 * k);
  vec2 q = vec2(cos(a), sin(a)) * r * 3.0 + vec2(TIME * 0.15 + 0.1 * sin(6.28318 * bassWobblePhase) * bassWobble, 0.0);
  float n = fbm(q + fbm(q + TIME * 0.1));
  vec3 col = mix(accentColor.rgb, amberColor.rgb, n);
  col = mix(col, inkColor.rgb, smoothstep(0.7, 0.9, n) * max(onset, dropEnergy));
  gl_FragColor = vec4(mix(bgColor.rgb, col, smoothstep(0.25, 0.8, n) * (0.5 + rms)), 1.0);
}
