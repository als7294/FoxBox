/*{
  "DESCRIPTION": "A print halftone: dots sized by brightness, the screen turning slowly with the beat.",
  "CREDIT": "FoxBox (original filter, MIT)",
  "ISFVSN": "2",
  "CATEGORIES": [
    "FoxBox",
    "Filter"
  ],
  "INPUTS": [
    {
      "NAME": "inputImage",
      "TYPE": "image"
    },
    {
      "NAME": "beatPhase",
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
    }
  ]
}*/

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
mat2 transpose2(mat2 m) { return mat2(m[0][0], m[1][0], m[0][1], m[1][1]); }
void main() {
  float cell = (7.0 + 5.0 * (1.0 - rms)) * (1.0 + 0.8 * buildProgress) * (1.0 + 0.1 * bassHold * bassSub * bassOn);  // coarser as it builds
  float ang = 0.26 + 0.05 * sin(TIME * 0.2 + beatPhase * 6.28318);
  mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
  vec2 p = rot * gl_FragCoord.xy / cell;
  vec2 centre = (floor(p) + 0.5);
  vec2 cp = (transpose2(rot) * (centre * cell)) / RENDERSIZE;
  vec4 c = IMG_NORM_PIXEL(inputImage, cp);
  float r = sqrt(luma(c.rgb)) * 0.62;
  float dot_ = smoothstep(r, r - 0.08, length(p - centre));
  gl_FragColor = vec4(mix(bgColor.rgb, c.rgb, dot_), 1.0);
}
