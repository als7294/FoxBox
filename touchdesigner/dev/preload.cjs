// preview.cjs's two windows: the camera (a clip, as renderer/touchdesigner/camera.ts sends FoxBox's camera: 960 x 540
// RGBA, an ellipse round the middle as the person matte in alpha) and TouchDesigner's picture back, kept for snapshots.
const { ipcRenderer, sharedTexture } = require('electron')
window.addEventListener('DOMContentLoaded', () => {
  if (new URLSearchParams(location.search).get('role') === 'cam') {
    const v = document.createElement('video')
    v.muted = true
    v.loop = true
    v.src = process.env.PREVIEW_CLIP_URL
    const c = new OffscreenCanvas(960, 540)
    const g = c.getContext('2d', { willReadFrequently: true })
    const tick = () => {
      g.drawImage(v, 0, 0, 960, 540)
      const img = g.getImageData(0, 0, 960, 540)
      for (let y = 0; y < 540; y++)
        for (let x = 0; x < 960; x++) {
          const d = ((x - 480) / 260) ** 2 + ((y - 300) / 300) ** 2
          img.data[(y * 960 + x) * 4 + 3] = d < 1 ? 255 : 0
        }
      ipcRenderer.send('cam', img.data.buffer)
    }
    // 30 a second on a timer: the window is hidden, and requestVideoFrameCallback waits while it doesn't draw
    v.play().then(() => setInterval(tick, 33))
  } else {
    const c = document.createElement('canvas')
    c.width = 1280
    c.height = 720
    document.body.append(c)
    const g = c.getContext('2d')
    window.__got = 0
    sharedTexture.setSharedTextureReceiver(async (data) => {
      const imp = data.importedSharedTexture ?? data
      const vf = imp.getVideoFrame()
      g.drawImage(vf, 0, 0, 1280, 720)
      vf.close()
      imp.release()
      window.__got++
      window.__at.push(performance.now())
      if (window.__at.length > 600) window.__at.shift()
      // The flash check's samples: the picture's mean brightness, whole and by quarter (0-1); then the two outer columns
      // each side (beside the person: the MASK FIRST check's trails).
      tg.drawImage(c, 0, 0, 16, 8)
      const d = tg.getImageData(0, 0, 16, 8).data
      const q = [0, 0, 0, 0, 0, 0]
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 16; x++) {
          const i = (y * 16 + x) * 4
          const l = (d[i] * 0.2126 + d[i + 1] * 0.7152 + d[i + 2] * 0.0722) / 255
          q[0] += l / 128
          q[1 + (y < 4 ? 0 : 2) + (x < 8 ? 0 : 1)] += l / 32
          if (x < 2 || x > 13) q[5] += l / 32
        }
      window.__lum.push([performance.now(), q])
      if (window.__lum.length > 900) window.__lum.shift()
    })
    const tiny = document.createElement('canvas')
    tiny.width = 16
    tiny.height = 8
    const tg = tiny.getContext('2d', { willReadFrequently: true })
    window.__lum = []
    // Flashes a second (WCAG-style): a swing of 10 % or more of full brightness against the last extreme, the darker side
    // under 0.8, is half a flash; the most in any 1 s window since `since`, over the whole picture and its quarters.
    window.__flashes = (since) => {
      const s = window.__lum.filter(([t]) => t >= since)
      let worst = 0
      for (let k = 0; k < 5; k++) {
        const turns = []
        let ext = s.length ? s[0][1][k] : 0
        let dir = 0
        for (const [t, q] of s) {
          const v = q[k]
          if ((dir > 0 && v > ext) || (dir < 0 && v < ext)) ext = v // follow the swing; before the first one, hold the start
          if (Math.abs(v - ext) >= 0.1 && Math.min(v, ext) < 0.8) {
            const now = v > ext ? 1 : -1
            if (now !== dir) turns.push(t)
            dir = now
            ext = v
          }
        }
        for (let i = 0; i < turns.length; i++) {
          let n = 0
          while (i + n < turns.length && turns[i + n] - turns[i] < 1000) n++
          worst = Math.max(worst, n / 2)
        }
      }
      return worst
    }
    window.__at = []
    // Frame intervals since `since` (ms): their 95th percentile and the longest (choppy pictures show here first).
    window.__intervals = (since) => {
      const t = window.__at.filter((x) => x >= since)
      const d = t.slice(1).map((x, i) => x - t[i]).sort((a, b) => a - b)
      return d.length ? { p95: Math.round(d[Math.floor(d.length * 0.95)] * 10) / 10, max: Math.round(d[d.length - 1]) } : null
    }
    window.__snap = () => c.toDataURL('image/png')
    // The motion check: the share of pixels whose brightness changes by more than 8/255 over `ms` (a frozen picture: 0).
    const luma = () => {
      const d = g.getImageData(0, 0, 1280, 720).data
      const out = new Uint8Array(d.length / 4)
      for (let i = 0; i < out.length; i++) out[i] = (d[i * 4] * 54 + d[i * 4 + 1] * 183 + d[i * 4 + 2] * 19) >> 8
      return out
    }
    window.__motion = async (ms) => {
      const a = luma()
      await new Promise((r) => setTimeout(r, ms))
      const b = luma()
      let n = 0
      for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 8) n++
      return n / a.length
    }
  }
})
