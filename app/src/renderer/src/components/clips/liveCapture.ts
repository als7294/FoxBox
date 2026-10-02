/**
 * SAVE CLIP's LIVE mode: films a running visuals stage as it plays, with the live sound. The stage canvas is copied
 * each animation frame into a clip-sized canvas (cropped to fill the format, watermark on), recorded with the given
 * audio node (the live masked output, never the dry mic) and handed back as a plain MP4 (camera remux) when stopped.
 */
import { coverCrop, drawWatermark, type Layout } from '@/components/camera/compose'
import { pickMimeType } from '@/components/camera/recording'
import { defragment } from '@/components/camera/remux'
import { useVisuals } from '@/state/visuals'
import { TD_LABEL } from '@/visuals/live/bases/touchdesigner'
import { sceneHasTd } from '@/visuals/live/compositor'
import { CLIP_SIZE, clipFileName, type ClipAspect } from './render'

export interface LiveCapture {
  /** Stops and resolves with the clip. */
  stop(): Promise<{ blob: Blob; name: string; seconds: number }>
  cancel(): void
}

export function startLiveCapture(
  stage: HTMLCanvasElement,
  sound: { ctx: AudioContext; node: AudioNode },
  o: { aspect: ClipAspect; watermark: boolean },
): LiveCapture {
  const mime = pickMimeType()
  if (!mime) throw new Error('This Mac can’t record video here.')
  const [w, h] = CLIP_SIZE[o.aspect]
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const ctx = out.getContext('2d', { alpha: false })!
  const stamp = document.createElement('canvas')
  const L: Layout = { w, h, cam: { x: 0, y: 0, w, h }, wave: { x: 0, y: h, w, h: 0 } }
  const t0 = performance.now()
  let raf = 0
  let touchDesigner = false // the base was TOUCHDESIGNER at some point while it filmed
  const draw = () => {
    raf = requestAnimationFrame(draw)
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, w, h)
    if (stage.width > 2 && stage.height > 2) {
      const c = coverCrop(stage.width, stage.height, { x: 0, y: 0, w, h })
      ctx.drawImage(stage, c.x, c.y, c.w, c.h, 0, 0, w, h)
    }
    if (o.watermark) drawWatermark(ctx, L, (performance.now() - t0) / 1000, stamp)
    if (sceneHasTd(useVisuals.getState().scene)) touchDesigner = true // labels the file's metadata
  }
  draw()
  const dest = sound.ctx.createMediaStreamDestination()
  sound.node.connect(dest)
  const stream = new MediaStream([...out.captureStream(30).getVideoTracks(), ...dest.stream.getAudioTracks()])
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000, audioBitsPerSecond: 192_000 })
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data)
  }
  const done = new Promise<void>((resolve) => (rec.onstop = () => resolve()))
  rec.start(500)
  const release = () => {
    cancelAnimationFrame(raf)
    try {
      sound.node.disconnect(dest)
    } catch {
      // already gone with the live engine
    }
    stream.getTracks().forEach((t) => t.stop())
  }
  return {
    async stop() {
      if (rec.state !== 'inactive') rec.stop()
      await done
      release()
      const seconds = (performance.now() - t0) / 1000
      let blob = new Blob(chunks, { type: mime })
      const plain = mime.startsWith('video/mp4') ? defragment(await blob.arrayBuffer(), touchDesigner ? TD_LABEL : undefined) : null
      if (plain) blob = new Blob([plain], { type: mime })
      const name = clipFileName(o.aspect).replace(/\.mp4$/, mime.startsWith('video/mp4') ? '.mp4' : '.webm')
      return { blob, name, seconds }
    },
    cancel() {
      if (rec.state !== 'inactive') rec.stop()
      release()
    },
  }
}
