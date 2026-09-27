import { encodeWav, type PcmAudio } from './wav'

/** Formats the engine ingests directly (POST /api/sources/upload). Everything else is decoded here first. */
const ENGINE_FORMATS = new Set(['wav', 'wave', 'aif', 'aiff', 'flac', 'mp3'])

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function engineAccepts(name: string): boolean {
  return ENGINE_FORMATS.has(extensionOf(name))
}

/** Decodes any format Chromium can read (m4a/aac, ogg, opus, webm, mp4 audio, …) to PCM at `sampleRate`. */
export async function decodeToPcm(data: ArrayBuffer, sampleRate = 48_000): Promise<PcmAudio> {
  const ctx = new OfflineAudioContext(1, 1, sampleRate)
  let buffer: AudioBuffer
  try {
    buffer = await ctx.decodeAudioData(data.slice(0))
  } catch {
    throw new Error('This file has no audio that can be decoded.')
  }
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice())
  return { sampleRate: buffer.sampleRate, channels }
}

export interface PreparedUpload {
  blob: Blob
  filename: string
  /** True when the file was decoded and re-encoded as WAV in the app. */
  converted: boolean
}

/** Keep engine-readable files as they are; convert the rest to 24-bit WAV via Web Audio. */
export async function prepareUpload(file: File, force = false): Promise<PreparedUpload> {
  if (!force && engineAccepts(file.name)) return { blob: file, filename: file.name, converted: false }
  const pcm = await decodeToPcm(await file.arrayBuffer())
  const base = file.name.replace(/\.[^.]+$/, '') || 'import'
  return { blob: new Blob([encodeWav(pcm, 24)], { type: 'audio/wav' }), filename: `${base}.wav`, converted: true }
}
