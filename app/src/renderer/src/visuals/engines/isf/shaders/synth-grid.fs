/*{
  "DESCRIPTION": "A perspective floor grid scrolling on the beat under a glowing horizon.",
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
      "NAME": "beatPhase",
      "TYPE": "float",
      "DEFAULT": 0
    },
    {
      "NAME": "bpm",
      "TYPE": "float",
      "DEFAULT": 140
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
  vec2 uv = isf_FragNormCoord;
  float horizon = 0.45 - 0.08 * bassHold * bassSub * bassOn;  // a held sub presses the horizon down
  vec3 c = bgColor.rgb;
  if (uv.y < horizon) {
    float d = (horizon - uv.y) + 1e-3;
    float z = 0.25 / d + TIME * bpm / 60.0 * 0.5;
    float x = (uv.x - 0.5) / d + 0.3 * sin(6.28318 * bassWobblePhase) * bassWobble * bassGrowl;
    float gx = smoothstep(0.06, 0.0, abs(fract(x * 0.6) - 0.5) - 0.44);
    float gz = smoothstep(0.08, 0.0, abs(fract(z) - 0.5) - 0.42);
    float fade = smoothstep(0.0, 0.3, d);
    c += mix(accentColor.rgb, inkColor.rgb, dropEnergy) * max(gx, gz) * fade * (0.6 + 0.8 * low + 0.3 * (1.0 - beatPhase) + dropEnergy);
  } else {
    float h = uv.y - horizon;
    c += mix(amberColor.rgb, iceColor.rgb, clamp(h * 2.0, 0.0, 1.0)) * exp(-h * 9.0) * (0.4 + low + buildProgress);
  }
  gl_FragColor = vec4(c, 1.0);
}
