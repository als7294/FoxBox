/*{
  "DESCRIPTION": "Beat strobe: flashes on the beat and the drop hit, never more than 3 a second (photosensitivity), in ink or, on a drop, the accent. The held breath before a drop dims the picture so the hit lands. With reduced motion it only dims.",
  "CREDIT": "FoxBox (original filter, MIT)",
  "ISFVSN": "2",
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

void main() {
  vec2 uv = isf_FragNormCoord;
  vec3 col = IMG_NORM_PIXEL(inputImage, uv).rgb;
  // The held breath: the picture sinks just before the hit.
  col *= 1.0 - 0.6 * preDrop;
  // beatFlash is FoxBox's limited strobe envelope (at most 3 flashes a second; 0 with reduced motion).
  vec3 flash = mix(inkColor.rgb, accentColor.rgb, clamp(dropEnergy * 1.5, 0.0, 1.0));
  float f = beatFlash * (0.45 + 0.4 * clamp(dropEnergy + buildProgress * 0.5, 0.0, 1.0));
  // The flash reads as light spreading from the centre, not a flat fill.
  vec2 d = (uv - 0.5) * vec2(RENDERSIZE.x / RENDERSIZE.y, 1.0);
  f *= 1.0 - 0.35 * smoothstep(0.2, 0.9, length(d));
  col = mix(col, flash, f);
  gl_FragColor = vec4(col, 1.0);
}
