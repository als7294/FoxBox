/*{
  "DESCRIPTION": "Stars streaming out of the centre; faster with the level, a burst on each onset.",
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

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * RENDERSIZE) / min(RENDERSIZE.x, RENDERSIZE.y);
  vec3 c = bgColor.rgb;
  float speed = 0.3 + rms * 2.5 + onset;
  for (int layer = 0; layer < 4; layer++) {
    float fl = float(layer);
    float depth = fract(TIME * speed * 0.1 + fl * 0.25);
    vec2 q = p / (depth + 0.05) * 6.0 + fl * 17.0;
    vec2 cell = floor(q);
    vec2 f = fract(q) - 0.5;
    float h = hash(cell);
    float star = smoothstep(0.08, 0.0, length(f - (vec2(hash(cell + 3.1), hash(cell + 7.7)) - 0.5) * 0.6)) * step(0.75, h);
    c += mix(inkColor.rgb, iceColor.rgb, h) * star * depth * 1.5;
  }
  gl_FragColor = vec4(c, 1.0);
}
