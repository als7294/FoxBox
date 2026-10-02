// The TouchDesigner camera's readback (1.6), off the page's main thread (which composites the stage): each camera
// frame arrives as a VideoFrame (camera.ts; the raw camera, or MASK FIRST's picture), is scaled to 960 x 540 RGBA, gets
// the person matte in its alpha, and goes straight to main on the camera's MessagePort (FoxBox's Syphon server "FoxBox
// Camera"). It answers {done} after each one, so the page sends the next only then: one in flight, never a queue.

const W = 960
const H = 540
const canvas = new OffscreenCanvas(W, H)
const g = canvas.getContext('2d', { willReadFrequently: true })!
let port: MessagePort | null = null
/** The person matte (0-1, covering the whole frame), the latest the page sent; none yet: alpha 0. */
let matte: { data: Float32Array; width: number; height: number } | null = null
const columns = new Int32Array(W) // the matte's column for each of the frame's
let columnsFor = -1

function applyMatte(px: Uint8ClampedArray): void {
  if (!matte) {
    for (let i = 3; i < px.length; i += 4) px[i] = 0
    return
  }
  const { data, width: mw, height: mh } = matte
  if (columnsFor !== mw) {
    columnsFor = mw
    for (let x = 0; x < W; x++) columns[x] = Math.min(mw - 1, Math.floor((x * mw) / W))
  }
  for (let y = 0, o = 3; y < H; y++) {
    const row = Math.min(mh - 1, Math.floor((y * mh) / H)) * mw
    for (let x = 0; x < W; x++, o += 4) px[o] = data[row + columns[x]!]! * 255
  }
}

self.onmessage = (e: MessageEvent<{ port?: MessagePort; frame?: VideoFrame; matte?: typeof matte }>) => {
  const d = e.data
  if (d.port) port = d.port
  if (d.matte !== undefined) matte = d.matte
  if (!d.frame) return
  try {
    g.drawImage(d.frame, 0, 0, W, H)
  } finally {
    d.frame.close()
  }
  try {
    const img = g.getImageData(0, 0, W, H)
    applyMatte(img.data)
    // copied, not transferred: Electron's ports to main carry ports, not ArrayBuffers, in a transfer list (the post threw)
    port?.postMessage({ rgba: img.data.buffer, width: W, height: H })
  } finally {
    self.postMessage({ done: true })
  }
}
