/*{
  "DESCRIPTION": "Punches in on every hit and breathes with the beat.",
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
      "NAME": "onset",
      "TYPE": "float",
      "DEFAULT": 0
    },
    {
      "NAME": "beatPhase",
      "TYPE": "float",
      "DEFAULT": 0
    },
    {
      "NAME": "calm",
      "TYPE": "float",
      "DEFAULT": 0
    }
  ]
}*/

void main() {
  float beat = pow(1.0 - beatPhase, 4.0);
  float z = 1.0 + (0.08 * onset + 0.025 * beat + 0.04 * buildProgress * beat + 0.12 * dropHit + 0.04 * bassHit) * (1.0 - 0.7 * calm);
  vec2 uv = (isf_FragNormCoord - 0.5) / z + 0.5;
  gl_FragColor = IMG_NORM_PIXEL(inputImage, uv);
}
