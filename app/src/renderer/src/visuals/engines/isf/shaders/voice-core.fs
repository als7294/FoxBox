/*{
  "DESCRIPTION": "An orb sized by the voice, with a halo that follows the song.",
  "CREDIT": "FoxBox (original shader, MIT)",
  "ISFVSN": "2",
  "CATEGORIES": [
    "FoxBox"
  ],
  "INPUTS": [
    {
      "NAME": "voiceLevel",
      "TYPE": "float",
      "DEFAULT": 0
    },
    {
      "NAME": "songLevel",
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
  float voice = max(voiceLevel, rms);
  float core = smoothstep(0.1 + voice * 0.25, 0.0, r);
  float halo = 0.03 / (abs(r - 0.3 - songLevel * 0.15) + 0.03) * songLevel;
  vec3 c = bgColor.rgb + accentColor.rgb * core * (0.8 + onset * 0.6) + amberColor.rgb * core * core;
  c += iceColor.rgb * halo * 0.6;
  gl_FragColor = vec4(c, 1.0);
}
