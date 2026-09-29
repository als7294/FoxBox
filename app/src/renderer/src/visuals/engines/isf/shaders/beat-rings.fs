/*{
  "DESCRIPTION": "A ring leaves the centre on every beat; the bar's downbeat rings wider.",
  "CREDIT": "FoxBox (original shader, MIT)",
  "ISFVSN": "2",
  "CATEGORIES": [
    "FoxBox"
  ],
  "INPUTS": [
    {
      "NAME": "beatPhase",
      "TYPE": "float",
      "DEFAULT": 0
    },
    {
      "NAME": "barPhase",
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
  float r = length(p);
  float c = 0.0;
  for (int k = 0; k < 4; k++) {
    float age = beatPhase + float(k);
    float radius = age * (0.18 - 0.08 * buildProgress);  // rings tighten through a build
    c += smoothstep(0.012, 0.0, abs(r - radius)) * exp(-age * 0.9);
  }
  float bar = smoothstep(0.02, 0.0, abs(r - barPhase * 0.7)) * (1.0 - barPhase);
  float shock = smoothstep(0.03, 0.0, abs(r - (1.0 - dropEnergy) * 0.9)) * dropEnergy;  // the drop's shock ring
  vec3 col = bgColor.rgb + accentColor.rgb * c * (0.6 + rms + 0.5 * bassHit) + amberColor.rgb * bar * 0.8 + inkColor.rgb * shock * 1.5;
  gl_FragColor = vec4(col, 1.0);
}
