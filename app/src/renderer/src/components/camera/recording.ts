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

/** FoxBox-clip-2026-09-27-0231.mp4 */
export function clipName(mime: string, at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const stamp = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}`
  return `FoxBox-clip-${stamp}.${extensionOf(mime)}`
}
