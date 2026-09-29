/*{
  "DESCRIPTION": "A ring tunnel moving on the beat; it brightens with the level.",
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
  float r = length(p) + 1e-3;
  float a = atan(p.y, p.x) + 0.3 * sin(6.28318 * bassWobblePhase) * bassWobble * bassGrowl;
  float z = 0.35 * (1.0 + buildProgress) / r + TIME * bpm / 120.0;  // deeper through a build
  float rings = smoothstep(0.45, 0.5, fract(z)) * smoothstep(0.55, 0.5, fract(z));
  float spokes = 0.5 + 0.5 * cos(a * 8.0 + z * 0.5);
  float pulse = 1.0 - beatPhase;
  vec3 col = mix(accentColor.rgb, amberColor.rgb, spokes);
  vec3 c = mix(bgColor.rgb, col, rings * (0.35 + rms * 1.4 + 0.3 * pulse * pulse + 2.0 * dropEnergy)) * smoothstep(0.0, 0.25, r);
  c += amberColor.rgb * high * 0.15 * spokes * smoothstep(0.4, 0.0, r);
  gl_FragColor = vec4(c, 1.0);
}
