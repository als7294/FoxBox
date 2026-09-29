/**
 * Build-up and drop for the visuals (1.5 SMART VISUALS), as AudioFrame fields every style and the AUTO-VJ director
 * can read:
 *   section        intro | verse | build | drop | breakdown | outro
 *   buildProgress  0..1, eased (slow, then faster): the tension through a build; 0 outside builds
 *   preDrop        the held breath before a drop: its pre-drop gap (the low end / energy cut) or at least its last beat
 *   dropIn         beats to the next drop hit, when predictable
 *   dropHit        true on the one frame a drop lands
 *   dropEnergy     1 at the hit, falling to 0 over one bar (eased)
 *   dropIndex      1 for the first drop, 2 for the second… (0 before the first)
 *   drop           at a drop, for its first bar (the 1.3 field, same meaning)
 * TRACK mode: StructureTrack / StructureReader over the song's precomputed v0.10 SongStructure.
 * LIVE INPUT: LiveStructure (a rolling detector, see liveStructure.ts).
 */

export type SectionKind = 'intro' | 'verse' | 'build' | 'drop' | 'breakdown' | 'outro'

export interface StructureFrame {
  section: SectionKind
  buildProgress: number
  preDrop: boolean
  dropIn: number | null
  dropHit: boolean
  dropEnergy: number
  dropIndex: number
  drop: boolean
}

/** The v0.10 SongStructure JSON, as far as the reader needs it. */
export interface SongStructureJson {
  sections: { kind: SectionKind; start_s: number; end_s: number; start_bar: number; energy: number }[]
  drops_s: number[]
  builds: [number, number][]
  phrase_bars: number
  energy_fps: number
  energy_b64: string
}

/** Tension rises slowly, then faster, into the drop. */
export const easeBuild = (p: number): number => Math.pow(Math.min(1, Math.max(0, p)), 1.6)
/** The release after the hit: fast at first, settling over the bar. */
export const dropDecay = (x: number): number => (x >= 1 || x < 0 ? 0 : (1 - x) * (1 - x))

function decodeEnergy(b64: string): Uint8Array {
  if (!b64) return new Uint8Array(0)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export class StructureTrack {
  private readonly energy: Uint8Array
  /** Per drop: where its pre-drop moment starts (the gap before it, at least one beat). */
  private readonly preDropFrom: number[]

  constructor(
    readonly json: SongStructureJson,
    readonly bpm: number,
  ) {
    this.energy = decodeEnergy(json.energy_b64)
    const beat = 60 / bpm
    this.preDropFrom = json.drops_s.map((d) => {
      // the gap: walking back from the hit while the energy sits under 60 % of the bar before it (at most one bar)
      let from = d - beat
      const ref = this.energyMean(d - 8 * beat, d - 4 * beat)
      if (ref > 0) {
        for (let t = d - 1 / json.energy_fps; t > d - 4 * beat; t -= 1 / json.energy_fps) {
          if (this.energyAt(t) < 0.6 * ref) from = Math.min(from, t)
          else if (t < d - beat) break
        }
      }
      return from
    })
  }

  energyAt(t: number): number {
    const i = Math.floor(t * this.json.energy_fps)
    return i >= 0 && i < this.energy.length ? this.energy[i]! / 255 : 0
  }

  private energyMean(a: number, b: number): number {
    let s = 0
    let n = 0
    for (let t = a; t < b; t += 1 / this.json.energy_fps) {
      s += this.energyAt(t)
      n++
    }
    return n ? s / n : 0
  }

  /** Everything but dropHit (which needs the previous read) at song time `t`. */
  at(t: number): Omit<StructureFrame, 'dropHit'> {
    const beat = 60 / this.bpm
    const bar = 4 * beat
    const secs = this.json.sections
    const sec = secs.find((s) => t >= s.start_s && t < s.end_s) ?? (t < 0 ? secs[0] : secs[secs.length - 1])
    const build = this.json.builds.find(([a, d]) => t >= a && t < d)
    const drops = this.json.drops_s
    const next = drops.findIndex((d) => d > t)
    const lastIdx = next < 0 ? drops.length - 1 : next - 1
    const last = lastIdx >= 0 ? drops[lastIdx]! : null
    return {
      section: sec?.kind ?? 'intro',
      buildProgress: build ? easeBuild((t - build[0]) / (build[1] - build[0])) : 0,
      preDrop: next >= 0 && t >= this.preDropFrom[next]! && t < drops[next]!,
      dropIn: next >= 0 ? ((drops[next]! - t) / beat) : null,
      dropEnergy: last != null ? dropDecay((t - last) / bar) : 0,
      dropIndex: lastIdx + 1,
      drop: last != null && t - last < bar,
    }
  }
}

/** Reads the structure at the playhead each frame; a drop hit fires once when playback crosses it (not on a seek). */
export class StructureReader {
  private last: number | null = null

  constructor(readonly track: StructureTrack) {}

  read(positionS: number): StructureFrame {
    const prev = this.last
    this.last = positionS
    const crossed = prev != null && positionS > prev && positionS - prev < 0.5 && this.track.json.drops_s.some((d) => d > prev && d <= positionS)
    return { ...this.track.at(positionS), dropHit: crossed }
  }
}
