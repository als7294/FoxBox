/*{
  "DESCRIPTION": "Bass wobble: the picture warps with the bass line. The wobble's LFO drives the warp, a held sub holds a stretch, an 808 glide bends it, and each new note kicks it.",
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
  float k = 1.0 - 0.7 * calm;
  vec2 p = uv - 0.5;
  // A held sub holds a vertical stretch, growing into the note (bassHold: how far into its usual length).
  float hold = bassOn * bassSub * smoothstep(0.2, 1.0, bassHold);
  p.y /= 1.0 + 0.12 * hold * k;
  // An 808 glide bends the picture with the slide.
  float bend = clamp(bassGlide, -6.0, 6.0) * 0.004 * k * bassOn;
  p.x += bend * p.y * 4.0;
  // The wobble: a travelling warp on the LFO's phase, as deep as the growl (or the bass level without a known LFO).
  float lfo = sin(6.28318 * bassWobblePhase);
  float depth = (bassWobble > 0.5 ? bassGrowl : low * 0.5) * bassOn * k;
  p.x += 0.02 * depth * lfo * sin(p.y * 18.0 + 6.28318 * bassWobblePhase);
  // A new note kicks it outward.
  p *= 1.0 - 0.03 * bassHit * k;
  vec2 q = p + 0.5;
  vec3 col = IMG_NORM_PIXEL(inputImage, q).rgb;
  // The growl splits the colour a little on the wobble's peaks.
  vec2 s = vec2(0.004 * depth * max(lfo, 0.0), 0.0);
  vec2 qr = q + s;
  vec2 qb = q - s;
  col.r = IMG_NORM_PIXEL(inputImage, qr).r;
  col.b = IMG_NORM_PIXEL(inputImage, qb).b;
  gl_FragColor = vec4(col, 1.0);
}
