import { api, unwrap } from '@/api/client'
import type { RenderInfo, Song, SongPlacement } from '@/api/types'
import { loadAudioBuffer } from '@/audio/cache'
import { audioContext } from '@/audio/player'
import { player } from '@/audio/playerInstance'
import { barTime, type Placement, type SongGrid } from '@/state/song'

/** The preview starts this many bars before the drop and runs this many past its end. */
export const LEAD_BARS = 4

const gainOf = (db: number) => 10 ** (db / 20)

export interface Preview {
  /** AudioContext time the preview started, and the song time it started from. */
  at: number
  from: number
  length: number
  stop(): void
  ended: Promise<void>
}

/** The song time span a preview plays: 4 bars before the drop to 4 bars after it. */
export function previewSpan(grid: SongGrid, placement: Placement, songDuration: number, dropDuration: number) {
  const dropAt = barTime(grid, placement.atBar)
  const from = Math.max(0, dropAt - LEAD_BARS * grid.barS)
  const to = Math.min(songDuration, dropAt + dropDuration + LEAD_BARS * grid.barS)
  return { dropAt, from, to }
}

/**
 * Plays `song` from `from` for `length` s and the drop at `dropAt` (song time) over it, the song ducked under the voice,
 * through a safety limiter (the drop is mastered loud; a song on top would clip). Without a drop: just the song (HQ).
 */
function play(o: {
  song: AudioBuffer
  from: number
  length: number
  drop?: { buffer: AudioBuffer; at: number; voiceEnd: number } | null
  songGainDb?: number
  dropGainDb?: number
  duckDb?: number
}): Preview {
  const ac = audioContext()
  void ac.resume()
  player.pause()
  const bus = ac.createDynamicsCompressor()
  bus.threshold.value = -3
  bus.knee.value = 0
  bus.ratio.value = 20
  bus.attack.value = 0.002
  bus.release.value = 0.1
  bus.connect(ac.destination)
  const at = ac.currentTime + 0.05
  const songGain = ac.createGain()
  songGain.gain.value = gainOf(o.songGainDb ?? 0)
  songGain.connect(bus)
  const shape = ac.createGain()
  shape.connect(songGain)
  const sources: AudioBufferSourceNode[] = []
  const song = ac.createBufferSource()
  song.buffer = o.song
  song.connect(shape)
  song.start(at, o.from, o.length)
  sources.push(song)
  if (o.drop) {
    const d0 = at + o.drop.at - o.from
    const d1 = d0 + o.drop.voiceEnd
    const low = gainOf(o.duckDb ?? -6)
    const g = shape.gain
    g.setValueAtTime(1, at)
    g.setValueAtTime(1, Math.max(at, d0 - 0.08))
    g.linearRampToValueAtTime(low, d0)
    g.setValueAtTime(low, Math.max(d0, d1 - 0.05))
    g.linearRampToValueAtTime(1, d1)
    const dropGain = ac.createGain()
    dropGain.gain.value = gainOf(o.dropGainDb ?? 0)
    dropGain.connect(bus)
    const drop = ac.createBufferSource()
    drop.buffer = o.drop.buffer
    drop.connect(dropGain)
    drop.start(Math.max(at, d0), Math.max(0, at - d0))
    drop.stop(at + o.length)
    sources.push(drop)
  }
  const ended = new Promise<void>((done) => (song.onended = () => done()))
  void ended.then(() => bus.disconnect())
  return {
    at,
    from: o.from,
    length: o.length,
    stop() {
      for (const s of sources) {
        try {
          s.stop()
        } catch {
          // not started, or already ended
        }
      }
    },
    ended,
  }
}

/** PREVIEW: the song and the current drop mixed here in Web Audio (levels and duck roughly as the engine does). */
export async function previewLocal(o: {
  song: Song
  buffer: AudioBuffer | null
  grid: SongGrid
  placement: Placement
  render: RenderInfo
}): Promise<Preview> {
  const [song, drop] = await Promise.all([o.buffer ?? loadAudioBuffer(o.song.audio_id), loadAudioBuffer(o.render.audio_id)])
  const { dropAt, from, to } = previewSpan(o.grid, o.placement, song.duration, drop.duration)
  return play({
    song,
    from,
    length: to - from,
    drop: { buffer: drop, at: dropAt, voiceEnd: o.render.tail_s ?? o.render.duration_s },
    songGainDb: o.placement.songGainDb,
    dropGainDb: o.placement.dropGainDb,
    duckDb: o.placement.duckDb,
  })
}

/** HQ: the engine's own mix (POST /api/mix, quality 'preview') of the same 4-bars-either-side excerpt. */
export async function previewHq(o: { grid: SongGrid; placement: SongPlacement; render: RenderInfo }): Promise<Preview> {
  const dropBars = Math.max(1, Math.ceil(o.render.duration_s / o.grid.barS))
  const placement: SongPlacement = {
    ...o.placement,
    start_bar: Math.max(1, o.placement.at_bar - LEAD_BARS),
    end_bar: o.placement.at_bar + dropBars + LEAD_BARS,
  }
  const mix = await unwrap(api.POST('/api/mix', { body: { render_id: o.render.id, placement, quality: 'preview' } }))
  const buffer = await loadAudioBuffer(mix.audio_id)
  const p = play({ song: buffer, from: 0, length: buffer.duration })
  // Report song time, so the lane's playhead lines up.
  return { ...p, from: mix.start_s }
}
