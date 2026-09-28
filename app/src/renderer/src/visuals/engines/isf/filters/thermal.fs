/*{
  "DESCRIPTION": "A thermal camera: brightness through ice, accent, amber to white; hotter with the level.",
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
      "NAME": "iceColor",
      "TYPE": "color",
      "DEFAULT": [
        0.486,
        0.784,
        1.0,
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

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
void main() {
  vec2 uv = isf_FragNormCoord;
  float t = clamp(luma(IMG_NORM_PIXEL(inputImage, uv).rgb) * (0.85 + 0.5 * rms), 0.0, 1.0);
  vec3 c = mix(bgColor.rgb, iceColor.rgb, smoothstep(0.0, 0.3, t));
  c = mix(c, accentColor.rgb, smoothstep(0.3, 0.6, t));
  c = mix(c, amberColor.rgb, smoothstep(0.6, 0.85, t));
  c = mix(c, inkColor.rgb, smoothstep(0.85, 1.0, t));
  gl_FragColor = vec4(c, 1.0);
}
