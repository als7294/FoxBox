/*{
  "DESCRIPTION": "Worn tape: tracking wobble on hits, colour bleed, scanlines and noise.",
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
      "NAME": "rms",
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

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 uv = isf_FragNormCoord;
  float wob = (0.002 + 0.012 * onset + 0.006 * buildProgress + 0.02 * dropHit) * (1.0 - 0.7 * calm);
  uv.x += sin(uv.y * 40.0 + TIME * 6.0 + 6.28318 * bassWobblePhase * bassWobble) * wob + (hash(vec2(floor(uv.y * 90.0), floor(TIME * 24.0))) - 0.5) * wob;
  float band = smoothstep(0.02, 0.0, abs(fract(uv.y * 0.5 - TIME * 0.08) - 0.5) - 0.01);
  vec2 ul = uv - vec2(0.004, 0.0);
  vec2 ur = uv + vec2(0.004, 0.0);
  vec3 c = vec3(IMG_NORM_PIXEL(inputImage, ul).r, IMG_NORM_PIXEL(inputImage, uv).g, IMG_NORM_PIXEL(inputImage, ur).b);
  c *= 0.88 + 0.12 * sin(gl_FragCoord.y * 3.14159);
  c += (hash(gl_FragCoord.xy + TIME) - 0.5) * (0.06 + 0.1 * rms) + band * 0.25;
  gl_FragColor = vec4(c, 1.0);
}
