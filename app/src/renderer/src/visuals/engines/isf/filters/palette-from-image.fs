/*{
  "DESCRIPTION": "Palette from image: takes the main colours of the picture beneath (Color Thief) and repaints it in them, darkest to lightest; the styles above follow the same colours. A build pushes it further, the drop saturates it.",
  "CREDIT": "FoxBox (original filter, MIT; colours by Color Thief, MIT)",
  "ISFVSN": "2",
  "FOXBOX_PALETTE": "extract",
  "CATEGORIES": [
    "FoxBox",
    "Filter",
    "Smart"
  ],
  "INPUTS": [
    {
      "NAME": "inputImage",
      "TYPE": "image"
    }
  ]
}*/

// A gradient map through the extracted palette: bg → ice → accent → amber → ink by brightness.
vec3 ramp(float l) {
  vec3 c = mix(bgColor.rgb, iceColor.rgb, smoothstep(0.0, 0.3, l));
  c = mix(c, accentColor.rgb, smoothstep(0.25, 0.55, l));
  c = mix(c, amberColor.rgb, smoothstep(0.5, 0.78, l));
  return mix(c, inkColor.rgb, smoothstep(0.75, 1.0, l));
}

void main() {
  vec2 uv = isf_FragNormCoord;
  vec4 src = IMG_NORM_PIXEL(inputImage, uv);
  float l = dot(src.rgb, vec3(0.299, 0.587, 0.114));
  vec3 mapped = ramp(clamp(l * (1.0 + 0.3 * dropEnergy), 0.0, 1.0));
  float amount = clamp(0.55 + 0.35 * buildProgress + 0.1 * dropEnergy, 0.0, 1.0);
  vec3 col = mix(src.rgb, mapped, amount);
  float g = dot(col, vec3(0.333));
  col = mix(vec3(g), col, 1.0 + 0.5 * dropEnergy * (1.0 - calm));
  gl_FragColor = vec4(col, 1.0);
}
