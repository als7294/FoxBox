/** MediaRecorder choices for the camera clip: MP4/H.264 + AAC where Chromium can, WebM otherwise. */

const TYPES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
]

export function pickMimeType(supported: (type: string) => boolean = (t) => MediaRecorder.isTypeSupported(t)): string | null {
  return TYPES.find((t) => supported(t)) ?? null
}

/** The camera filmed with a voice take: picture only (the mic records the voice). */
export function pickFilmType(supported: (type: string) => boolean = (t) => MediaRecorder.isTypeSupported(t)): string | null {
  return ['video/mp4;codecs=avc1.640028', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((t) => supported(t)) ?? null
}

export const extensionOf = (mime: string): 'mp4' | 'webm' => (mime.startsWith('video/mp4') ? 'mp4' : 'webm')

/**
 * The clip's file name from its first words, like the exports: "what-the-fuck-is_clip.mp4" (up to 4 words, as the exports of the
 * script or transcript); FoxBox-clip-2026-09-27-0231.mp4 when there are none.
 */
export function clipName(mime: string, words: readonly string[] = [], at = new Date()): string {
  const slug = words
    .map((w) => w.toLowerCase().replace(/[^a-z0-9]+/g, ''))
    .filter(Boolean)
    .slice(0, 4)
    .join('-')
  if (slug) return `${slug}_clip.${extensionOf(mime)}`
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}`
  return `FoxBox-clip-${stamp}.${extensionOf(mime)}`
}
