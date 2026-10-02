/** STRINGS, the film (stringsFilm.js): WHAT'S NEW 1.5.5 plays it live; the promo MP4 is rendered from it. */
export interface StringsFilm {
  /** The backing size in px (16:9); the film lays out in a 1920×1080 frame and scales to it. */
  resize(pxW: number, pxH: number): void
  /** Draws the moment t (seconds) on both canvases. */
  drawAt(t: number): void
  /** Frees the WebGL context, its targets, geometries and textures. */
  dispose(): void
}
export interface FilmChapter {
  from: number
  to: number
  /** The frame shown under reduced motion. */
  still: number
  /** Loops [from, to), else holds at `to`. */
  loop: boolean
}
export const FILM_DUR: number
/** One per guide step. */
export const CHAPTERS: readonly FilmChapter[]
export function loadFilmFonts(): Promise<void>
/** Throws without WebGL. */
export function createStringsFilm(glCanvas: HTMLCanvasElement, textCanvas: HTMLCanvasElement): StringsFilm
