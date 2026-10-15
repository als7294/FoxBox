/**
 * The library wheel's preview (REMIX): a track's preview clip (S3's preview route: ~20 s from about 40 % in, near the
 * drop) through REMIX's engine, faded in, the deck ducked under it while it plays; stopped (faded out) on release. One
 * at a time: a newer play wins over one still loading.
 */
export interface PreviewPlayer {
  play(trackId: string): Promise<void>
  stop(): void
  readonly playing: string | null
  dispose(): void
}

const DUCK_DB = -15

export function createPreview(opts: {
  ctx: BaseAudioContext
  /** The clip's encoded bytes (S3's preview route). */
  fetch: (trackId: string) => Promise<ArrayBuffer>
  /** The deck to duck under it (SongDeck.duck). */
  deck?: { duck(db: number | null): void } | null
}): PreviewPlayer {
  const { ctx } = opts
  let token = 0
  let now: { id: string; src: AudioBufferSourceNode; gain: GainNode } | null = null
  const fadeOut = (n: NonNullable<typeof now>) => {
    const t = ctx.currentTime
    n.gain.gain.cancelScheduledValues(t)
    n.gain.gain.setValueAtTime(n.gain.gain.value, t)
    n.gain.gain.linearRampToValueAtTime(0, t + 0.12)
    n.src.onended = null
    try {
      n.src.stop(t + 0.13)
    } catch {
      // never started
    }
  }
  const stop = () => {
    token++
    if (now) fadeOut(now)
    now = null
    opts.deck?.duck(null)
  }
  return {
    async play(trackId) {
      stop()
      const mine = token
      const bytes = await opts.fetch(trackId)
      if (mine !== token) return
      const buffer = await ctx.decodeAudioData(bytes)
      if (mine !== token) return
      const t = ctx.currentTime
      const gain = new GainNode(ctx, { gain: 0 })
      gain.gain.setValueAtTime(0, t)
      gain.gain.linearRampToValueAtTime(1, t + 0.03)
      const src = new AudioBufferSourceNode(ctx, { buffer })
      src.connect(gain).connect(ctx.destination)
      src.onended = () => {
        if (now?.src === src) stop()
      }
      src.start(t)
      now = { id: trackId, src, gain }
      opts.deck?.duck(DUCK_DB)
    },
    stop,
    get playing() {
      return now?.id ?? null
    },
    dispose: stop,
  }
}
