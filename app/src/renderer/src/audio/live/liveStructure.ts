/**
 * LIVE INPUT build-up and drop, rolling (no precompute): the StructureFrame fields (structure.ts) from what the
 * approximator hears, frame by frame.
 *   the bass down (under half its groove level) for 2+ bars → breakdown (before it ever came in: intro)
 *   a riser (brightness climbing over 2 bars) or a snare roll (hits per beat climbing) once the bass has been down a
 *   bar → build; the drop is expected on the next 8-bar phrase line at least a bar ahead (the grid re-anchors on
 *   every real drop), which gives buildProgress and dropIn
 *   an energy cut late in a build, or the last beat before the expected line → preDrop (never outside a build: a
 *   dip in a groove must not black the visuals out)
 *   the bass slamming back after a bar or more down → dropHit (one frame), section drop for 16 bars, dropEnergy
 *   over a bar
 */
import { dropDecay, easeBuild, type SectionKind, type StructureFrame } from './structure'

export interface LiveStructureInput {
  /** seconds (the audio clock) */
  t: number
  bpm: number
  /** mix level 0..1 */
  rms: number
  /** the > 4 kHz band level 0..1 (a riser's brightness) */
  high: number
  /** the bass stem level 0..1 */
  bass: number
  /** drums onset this frame (≥ 1 on a hit, else 0) */
  drumHit: number
}

const PHRASE_BARS = 8
const BASS_ON = 0.3
const BASS_OFF = 0.15

export class LiveStructure {
  private bassSlow = 0
  private groove = 0
  private barRms = 0
  private prevBarRms = 0
  private barStart: number | null = null
  private everIn = false
  private bassOffSince: number | null = null
  private section: SectionKind = 'intro'
  private buildStart: number | null = null
  private expectedDrop: number | null = null
  private lastDrop: number | null = null
  private dropIndex = 0
  private anchor: number | null = null
  private bright: { t: number; v: number }[] = []
  private hits: number[] = []
  private buildRms = 0
  private prevT: number | null = null

  update(x: LiveStructureInput): StructureFrame {
    const beat = 60 / Math.max(40, x.bpm)
    const bar = 4 * beat
    const dt = this.prevT == null ? 0 : Math.max(0, Math.min(0.1, x.t - this.prevT))
    this.prevT = x.t
    const k = 1 - Math.exp(-dt / beat) // the bass level smoothed over about a beat
    this.bassSlow += k * (x.bass - this.bassSlow)
    if (this.bassSlow >= BASS_ON) this.groove += (1 - Math.exp(-dt / (4 * bar))) * (this.bassSlow - this.groove)
    // the mix level of this bar and the one before (a sudden cut is the pre-drop gap)
    if (this.barStart == null || x.t - this.barStart >= bar) {
      this.prevBarRms = this.barRms || x.rms
      this.barStart = x.t
    }
    this.barRms += (1 - Math.exp(-dt / beat)) * (x.rms - this.barRms)

    this.bright.push({ t: x.t, v: x.high })
    while (this.bright.length && this.bright[0]!.t < x.t - 4 * bar) this.bright.shift()
    if (x.drumHit >= 1) this.hits.push(x.t)
    while (this.hits.length && this.hits[0]! < x.t - 2 * bar) this.hits.shift()

    let dropHit = false
    const down = Math.max(BASS_OFF, 0.45 * this.groove)
    const bassIn = this.bassSlow >= Math.max(BASS_ON, down)
    if (this.bassSlow < down) this.bassOffSince ??= x.t
    const awayBars = this.bassOffSince != null ? (x.t - this.bassOffSince) / bar : 0
    const back = x.bass >= Math.max(0.5, 0.8 * this.groove)

    if (bassIn || back) {
      if (this.bassOffSince != null && awayBars >= 1 && back && (awayBars >= 2 || this.buildStart != null || !this.everIn)) {
        dropHit = true // back after being away: the drop
        this.lastDrop = x.t
        this.dropIndex++
        this.anchor = x.t
      }
      if (this.bassSlow >= BASS_ON || dropHit) {
        this.bassOffSince = null
        this.everIn = true
        this.buildStart = null
        this.expectedDrop = null
        this.section = this.lastDrop != null && x.t - this.lastDrop < 16 * bar ? 'drop' : 'verse'
      }
    } else if (this.bassOffSince != null && (awayBars >= 1 || !this.everIn)) {
      if (this.buildStart == null && this.rising(x.t, bar)) {
        this.buildStart = x.t
        this.buildRms = x.rms
        const earliest = x.t + bar
        const phrase = PHRASE_BARS * bar
        this.expectedDrop = this.anchor != null ? this.anchor + Math.ceil((earliest - this.anchor) / phrase) * phrase : x.t + phrase
      }
      this.section = this.buildStart != null ? 'build' : !this.everIn ? 'intro' : awayBars >= 2 ? 'breakdown' : this.section
    }

    if (this.buildStart != null) this.buildRms += (1 - Math.exp(-dt / bar)) * (x.rms - this.buildRms)
    const building = this.section === 'build' && this.buildStart != null && this.expectedDrop != null
    const dropIn = building ? Math.max(0, (this.expectedDrop! - x.t) / beat) : null
    const progress = building ? easeBuild((x.t - this.buildStart!) / (this.expectedDrop! - this.buildStart!)) : 0
    const gap = building && progress > 0.5 && (x.rms < 0.4 * this.buildRms || this.barRms < 0.5 * this.prevBarRms)
    const since = this.lastDrop != null ? x.t - this.lastDrop : null
    return {
      section: this.section,
      buildProgress: progress,
      preDrop: gap || (dropIn != null && dropIn <= 1),
      dropIn,
      dropHit,
      dropEnergy: since != null ? dropDecay(since / bar) : 0,
      dropIndex: this.dropIndex,
      drop: since != null && since < bar,
    }
  }

  /** A riser (the last two bars brighter than the two before) or a snare roll (more, and denser, hits). */
  private rising(t: number, bar: number): boolean {
    if (!this.bright.length || this.bright[0]!.t > t - 4 * bar + 0.05) return false // four bars heard first
    const mean = (a: number, b: number) => {
      const v = this.bright.filter((s) => s.t >= a && s.t < b)
      return v.length ? v.reduce((s, x) => s + x.v, 0) / v.length : 0
    }
    const riser = mean(t - 2 * bar, t) > mean(t - 4 * bar, t - 2 * bar) + 0.04
    const now = this.hits.filter((h) => h >= t - bar).length
    const before = this.hits.length - now
    const roll = now >= 8 && now >= 1.5 * Math.max(1, before) // two or more hits a beat, and climbing
    return riser || roll
  }
}
