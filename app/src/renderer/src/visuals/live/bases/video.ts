/**
 * VIDEO: a muted, looping clip (`spec.src`) filling the frame ('cover') or all of it shown on the palette ground
 * ('contain'), drawn every frame. Until its first frame decodes, the ground; if it can't be decoded (or the file is
 * gone), a dim VIDEO UNAVAILABLE. Disposing stops it and lets go of the file.
 */
import type { BaseInstance, BaseSpec } from '../compositor'
import type { Palette } from '../registry'
import { context2d, fitRect, ground, makeCanvas, quietCard, setSize } from './kit'

export function videoBase(spec: BaseSpec, palette: Palette): BaseInstance {
  const canvas = makeCanvas()
  const ctx = context2d(canvas)
  const fit = spec.fit ?? 'cover'
  let failed = !spec.src
  let dirty = true
  const video = document.createElement('video')
  video.muted = true
  video.loop = true
  video.playsInline = true
  video.preload = 'auto'
  const fail = () => {
    failed = true
    dirty = true
  }
  video.addEventListener('error', fail)
  if (spec.src) {
    video.src = spec.src
    // A rejected play() (autoplay rules, a bad file) is the error event's business: never an unhandled rejection.
    video.play().catch(() => undefined)
  }

  return {
    canvas,
    resize(width, height) {
      if (setSize(canvas, width, height)) dirty = true
    },
    // Offline (a saved clip): seek to the frame's time and wait, so each exported frame shows the right picture.
    async prepare(a) {
      if (failed || !Number.isFinite(video.duration) || video.duration <= 0) return
      video.pause()
      const t = ((a.time % video.duration) + video.duration) % video.duration
      if (Math.abs(video.currentTime - t) < 0.001) return
      await new Promise<void>((done) => {
        const finish = () => {
          video.removeEventListener('seeked', finish)
          done()
        }
        video.addEventListener('seeked', finish)
        video.currentTime = t
        setTimeout(finish, 1000)
      })
    },
    frame() {
      if (!ctx) return
      if (failed) {
        if (dirty) quietCard(ctx, palette, spec.src ? 'VIDEO UNAVAILABLE' : 'NO VIDEO')
        dirty = false
        return
      }
      if (video.readyState < 2 || !video.videoWidth) {
        if (dirty) ground(ctx, palette)
        dirty = false
        return
      }
      const { width: w, height: h } = canvas
      const r = fitRect(video.videoWidth, video.videoHeight, w, h, fit)
      if (fit === 'contain') ground(ctx, palette)
      ctx.drawImage(video, r.x, r.y, r.w, r.h)
    },
    dispose() {
      video.removeEventListener('error', fail)
      video.pause()
      video.removeAttribute('src')
      video.load() // drops the decoder and the file
      setSize(canvas, 2, 2)
    },
  }
}
