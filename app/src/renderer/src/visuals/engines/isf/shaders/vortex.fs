/*{
  "DESCRIPTION": "A spiral that twists tighter with the mids.",
  "CREDIT": "FoxBox (original shader, MIT)",
  "ISFVSN": "2",
  "CATEGORIES": [
    "FoxBox"
  ],
  "INPUTS": [
    {
      "NAME": "mid",
      "TYPE": "float",
      "DEFAULT": 0
    },
    {
      "NAME": "rms",
      "TYPE": "float",
      "DEFAULT": 0
    },
    {
      "NAME": "beatPhase",
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
    }
  ]
}*/

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * RENDERSIZE) / min(RENDERSIZE.x, RENDERSIZE.y);
  float r = length(p);
  float a = atan(p.y, p.x);
  float twist = 4.0 + mid * 10.0 + buildProgress * 8.0;  // winds up through a build
  float s = sin(a * 5.0 + log(r + 1e-3) * twist - TIME * 1.5 + 1.5 * sin(6.28318 * bassWobblePhase) * bassWobble * bassGrowl);
  float line = smoothstep(0.3, 1.0, s) * smoothstep(0.0, 0.1, r) * exp(-r * 1.5);
  vec3 col = mix(mix(accentColor.rgb, iceColor.rgb, 0.5 + 0.5 * sin(TIME * 0.3 + r * 4.0)), inkColor.rgb, 0.5 * dropEnergy);
  gl_FragColor = vec4(bgColor.rgb + col * line * (0.5 + rms * 1.5 + 0.3 * (1.0 - beatPhase) + 2.0 * dropEnergy), 1.0);
}
