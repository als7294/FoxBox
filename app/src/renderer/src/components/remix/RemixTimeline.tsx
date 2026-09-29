/**
 * The REMIX TIMELINE (HARDWARE look): the head with the EditToolbar, the section tool row, the header column (lane
 * names, M / S, gain, SWAP ALL) beside a scrolling view of the bar ruler, the section blocks and the lanes' clips, and
 * the overview strip. waveform-playlist only plays (Tone playout); every waveform here is ours, drawn per clip from
 * the same decoded audio. FIT shows the whole remix; zooming in scrolls it sideways under the header column.
 */
import { useQuery } from '@tanstack/react-query'
import { usePlaybackAnimation, usePlaylistControls, WaveformPlaylistProvider, type ClipTrack } from '@waveform-playlist/browser'
import {
  createContext,
  use,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  remixApi,
  type GrooveClipSrc,
  type KitClipSrc,
  type Remix,
  type RemixClip,
  type RemixLane,
  type RemixRecipe,
  type RemixSection,
  type SectionKind,
} from '@/api/remix'
import { loadAudioBuffer } from '@/audio/cache'
import { audioContext } from '@/audio/player'
import { reportError } from '@/components/common/ErrorBoundary'
import { addFrame } from '@/visuals/frame'
import { PatchPicker } from './BassDnaPanel'
import { meterTap } from './meters'
import { EditToolbar, ShortcutsOverlay, ZOOMS, zoomStep } from './EditToolbar'
import { KitPicker } from './FlipCards'
import {
  beatToSec,
  displayLanes,
  isPlaceholder,
  laneKey,
  laneOpen,
  moveSection,
  pickupBeats,
  remixBeats,
  rulerBars,
  secToBeat,
  sectionBeat,
} from './arrangement'
import { cutSections, duplicateSections, loopRegion, nudgeSections, snapBeat, splitSection } from './edit'
import { dropMarkers, type DropMark } from './markers'
import pageCss from './page.module.css'
import { patchName, remix as actions, selectedSections, songBpm, useRemix, useSongs, useSoundLibrary } from './store'
import css from './timeline.module.css'

export const SECTION_LABEL: Record<SectionKind, string> = {
  intro: 'INTRO',
  verse: 'VERSE',
  build: 'BUILD',
  drop: 'DROP',
  breakdown: 'BREAK',
  outro: 'OUTRO',
}
const SECTION_COLOUR: Record<SectionKind, string> = {
  intro: 'var(--vb-sec-intro)',
  verse: 'var(--vb-sec-intro)',
  build: 'var(--vb-sec-build)',
  drop: 'var(--vb-sec-drop)',
  breakdown: 'var(--vb-sec-break)',
  outro: 'var(--vb-sec-outro)',
}
const ROLE_LABEL: Record<RemixLane['role'], string> = {
  drums: 'DRUMS',
  bass: 'BASS',
  vocals: 'VOCALS',
  other: 'OTHER',
  top: 'TOP',
  synth_bass: 'SYNTH BASS',
  kit: 'KIT',
}
/** How to fill an empty lane (a collapsed row says it). */
const EMPTY_HINT: Partial<Record<RemixLane['role'], string>> = {
  top: 'EMPTY · turn on ARP, POWER-UP or COIN in BASS DNA',
  synth_bass: 'EMPTY · BUILD a VIP take, or SWAP BASS → BASS DNA',
  kit: 'EMPTY · GENRE FLIP, or SWAP DRUMS → FLIP KIT',
}
const dbToGain = (db: number) => 10 ** (db / 20)
const clamp = (lo: number, v: number, hi: number) => Math.max(lo, Math.min(v, hi))

/** The playback position, every frame while playing (the provider's currentTime only updates on seek/stop). */
export function usePlayhead(): number {
  const { isPlaying, currentTime, visualTimeRef } = usePlaybackAnimation()
  const [t, setT] = useState(currentTime)
  useEffect(() => {
    setT(visualTimeRef.current ?? currentTime)
    return isPlaying ? addFrame(() => setT(visualTimeRef.current ?? 0)) : undefined
  }, [isPlaying, currentTime, visualTimeRef])
  return t
}

/** Every prepared clip's audio, decoded (audio ids are immutable, so each loads once). */
function useClipBuffers(r: Remix): Record<string, AudioBuffer> {
  const [buffers, setBuffers] = useState<Record<string, AudioBuffer>>({})
  const ids = [...new Set(r.lanes.flatMap((l) => l.clips.map((c) => c.audio_id).filter((x): x is string => Boolean(x))))]
  const key = ids.join()
  useEffect(() => {
    let live = true
    for (const aid of key ? key.split(',') : [])
      loadAudioBuffer(aid)
        .then((b) => live && setBuffers((prev) => (prev[aid] ? prev : { ...prev, [aid]: b })))
        .catch(() => undefined)
    return () => {
      live = false
    }
  }, [key])
  return buffers
}
const Buffers = createContext<Record<string, AudioBuffer>>({})

/** One playlist track per lane, with the lane's prepared clips placed at at_beat. */
function laneTracks(r: Remix, buffers: Record<string, AudioBuffer>): ClipTrack[] {
  return r.lanes.map((l) => ({
    id: l.id,
    name: laneName(l, r.recipe === 'mashup'),
    muted: l.mute,
    soloed: l.solo,
    volume: dbToGain(l.gain_db),
    pan: 0,
    clips: l.clips.flatMap((c) => {
      const b = c.audio_id ? buffers[c.audio_id] : undefined
      if (!b) return []
      const sr = b.sampleRate
      return [
        {
          id: c.id,
          audioBuffer: b,
          startSample: Math.round(beatToSec(c.at_beat, r.bpm) * sr),
          durationSamples: Math.min(b.length, Math.round(beatToSec(c.beats, r.bpm) * sr)),
          offsetSamples: 0,
          sampleRate: sr,
          sourceDurationSamples: b.length,
          gain: dbToGain(c.gain_db),
        },
      ]
    }),
  }))
}

/**
 * The playlist provider (playback only: its own waveform view isn't mounted, playback doesn't need it) around the
 * centre column, and the decoded clips for the timeline's waveforms.
 */
/** The app's audio rate; 44.1 kHz where there's no Web Audio (tests), so the page never falls over for want of one. */
const SAMPLE_RATE = (): number => (typeof AudioContext === 'undefined' ? 44100 : audioContext().sampleRate)

export function RemixPlaylist({ remix, children }: { remix: Remix; children: ReactNode }) {
  const buffers = useClipBuffers(remix)
  const tracks = useMemo(() => laneTracks(remix, buffers), [remix, buffers])
  return (
    <div className={pageCss.center}>
      <WaveformPlaylistProvider
        tracks={tracks}
        sampleRate={SAMPLE_RATE()}
        effects={meterTap}
        // The detail goes to the log; the page says it plainly.
        onError={(e) => {
          reportError('REMIX playback', e)
          useRemix.setState({ error: "Playback didn't start. Press PLAY again, or pick the take again." })
        }}
      >
        <Buffers value={buffers}>{children}</Buffers>
      </WaveformPlaylistProvider>
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ stepped-bar waveforms

/**
 * Loudness (0–1) per step over the clip's first `secs` of audio, cached per buffer: each step's RMS on a −42…−6 dB
 * scale, so a loud stem isn't a solid wall and quiet sections read lower (peaks would pin every bar at the top).
 */
const levelCache = new WeakMap<AudioBuffer, Map<string, Float32Array>>()
function levels(b: AudioBuffer, secs: number, n: number): Float32Array {
  const key = `${secs}:${n}`
  const hit = levelCache.get(b)?.get(key)
  if (hit) return hit
  const data = b.getChannelData(0)
  const len = Math.min(data.length, Math.round(secs * b.sampleRate))
  const out = new Float32Array(n)
  const per = len / n
  const stride = Math.max(1, Math.floor(per / 512)) // ~512 reads a step is plenty for a bar's height
  for (let i = 0; i < n; i++) {
    let sum = 0
    let count = 0
    for (let s = Math.floor(i * per), end = Math.floor((i + 1) * per); s < end; s += stride, count++) sum += data[s]! * data[s]!
    const db = 10 * Math.log10(sum / Math.max(1, count) + 1e-12)
    out[i] = clamp(0, (db + 42) / 36, 1)
  }
  if (!levelCache.has(b)) levelCache.set(b, new Map())
  levelCache.get(b)!.set(key, out)
  return out
}

/** A bar of height `h` (of 10) centred on the line, at x…x+w of 100. */
const bar = (x: number, w: number, h: number) =>
  `M${x.toFixed(2)},${(10 - h).toFixed(2)}h${w.toFixed(3)}v${(2 * h).toFixed(2)}h${(-w).toFixed(3)}Z`

type WaveKind = 'bars' | 'held' | 'blips'
function wavePath(b: AudioBuffer, secs: number, bars: number, kind: WaveKind): string {
  // bars: two steps a bar, each 70% of its cell, centred · held: one block a bar · blips: a step a beat, only the hits
  // that stand out. Steps start on the clip's bar lines, so touching clips continue one strip.
  const n =
    kind === 'held' ? Math.max(1, Math.round(bars)) : Math.max(kind === 'blips' ? 4 : 2, Math.round(bars * (kind === 'blips' ? 4 : 2)))
  const v = levels(b, secs, n)
  const w = 100 / n
  const loud = Math.max(...v) * 0.7
  let d = ''
  for (let i = 0; i < n; i++) {
    if (kind === 'held') d += bar(i * w + 0.4, w - 0.8, Math.max(1.5, v[i]! * 5))
    else if (kind === 'blips')
      d += v[i]! > loud ? `M${(i * w).toFixed(2)},${(8 - v[i]! * 6).toFixed(1)}h${(w * 0.6).toFixed(2)}v3h${(-w * 0.6).toFixed(2)}Z` : ''
    else d += bar(i * w + w * 0.15, w * 0.7, Math.max(0.5, v[i]! * 8.5))
  }
  return d
}

/** SYNTH BASS: the groove's own hits (BASS DNA), the first long and tallest. */
function hitsPath(notes: { beat: number; beats: number; vel: number }[], clipBeats: number): string {
  return notes
    .filter((n) => n.beat < clipBeats)
    .map((n, i) =>
      bar(
        (n.beat / clipBeats) * 100,
        Math.max(0.3, (Math.min(n.beats, clipBeats - n.beat) / clipBeats) * 80),
        i ? 4 + 3.5 * Math.min(1, n.vel) : 9.5,
      ),
    )
    .join('')
}

/** The groove a SYNTH BASS clip plays (the query BassDnaPanel runs, shared by its key). */
function useGrooveNotes(r: Remix, src: RemixClip['src'], on: boolean) {
  const g = src.kind === 'groove' ? src : null
  const songId = g && r.sources.find((s) => s.slot === g.slot)?.song_id
  return useQuery({
    queryKey: ['remix', 'groove', songId, g?.start_bar, g?.bars],
    queryFn: () => remixApi.groove(songId!, g!.start_bar, g!.bars),
    enabled: Boolean(on && songId && g),
    staleTime: Infinity,
  }).data?.notes
}

// ------------------------------------------------------------------------------------------------ the timeline

/** 'DROP 2' (drops are numbered), else the kind. */
export function sectionName(r: Remix, i: number): string {
  const s = r.sections[i]!
  return s.kind === 'drop' ? `DROP ${r.sections.slice(0, i + 1).filter((x) => x.kind === 'drop').length}` : SECTION_LABEL[s.kind]
}

const fmtLen = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`

/** Before a BUILD, what BUILD will change, in ember: the head's line, and each planned section's new part. */
const PLAN: Record<RemixRecipe, { part: string; status(drops: number): string; all?: boolean }> = {
  vip: { part: 'NEW BASS', status: (n) => `${n} DROP${n === 1 ? ' GETS' : 'S GET'} NEW BASS · PRESS BUILD` },
  mashup: { part: 'B’S DROP', status: () => 'B’S DROPS COME IN HERE' },
  flip: { part: 'NEW DRUMS', status: () => 'THE DRUMS GET RE-PROGRAMMED', all: true },
}
/** A section BUILD rebuilds under `plan`: the drops, or every section for a FLIP. */
const planned = (plan: RemixRecipe | undefined, s: RemixSection) => plan != null && (PLAN[plan].all || s.kind === 'drop')

export function RemixTimeline({
  remix,
  plan,
}: {
  remix: Remix
  /** The ORIGINAL before a BUILD (read-only), with what this recipe's BUILD will change. */
  plan?: RemixRecipe
}) {
  const zoom = useRemix((s) => s.zoom)
  const progress = useRemix((s) => s.progress)
  const section = useRemix((s) => s.section)
  const sectionSel = useRemix((s) => s.sectionSel)
  const readOnly = plan != null
  const sel = readOnly ? [] : selectedSections({ section, sectionSel })
  const lanes = displayLanes(remix.lanes)
  const beats = remixBeats(remix)
  const bpb = remix.beats_per_bar
  const take = remix.takes.find((t) => t.seed === remix.seed)
  const marks = useMemo(() => (readOnly ? [] : dropMarkers(remix, take)), [remix, take, readOnly])

  // The view's width is the FIT; zoom multiplies it.
  const view = useRef<HTMLDivElement>(null)
  const [viewW, setViewW] = useState(0)
  useLayoutEffect(() => {
    const el = view.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([e]) => setViewW(Math.floor(e!.contentRect.width)))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const pxPerBeat = beats > 0 && viewW > 0 ? (viewW / beats) * zoom : 0

  const { isPlaying, currentTime, visualTimeRef } = usePlaybackAnimation()
  const { seekTo } = usePlaylistControls()
  const playBeat = () => secToBeat(visualTimeRef.current ?? 0, remix.bpm)

  // A zoom keeps its anchor (the playhead; ⌘-scroll: the beat under the pointer) where it was in the view.
  const scale = useRef({ ppb: 0, anchor: null as number | null })
  useLayoutEffect(() => {
    const el = view.current
    const was = scale.current
    if (el && was.ppb && pxPerBeat && was.ppb !== pxPerBeat) {
      const beat = was.anchor ?? playBeat()
      const frac = clamp(0, (beat * was.ppb - el.scrollLeft) / el.clientWidth, 1)
      el.scrollLeft = beat * pxPerBeat - frac * el.clientWidth
    }
    scale.current = { ppb: pxPerBeat, anchor: null }
    syncMap()
  }, [pxPerBeat]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = view.current
    if (!el) return
    let acc = 0
    const onWheel = (e: WheelEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      e.preventDefault()
      acc += e.deltaY
      if (Math.abs(acc) < 40 || !scale.current.ppb) return // a trackpad sends many small steps: one zoom per notch
      const d = acc < 0 ? 1 : -1
      acc = 0
      if (!ZOOMS[ZOOMS.indexOf(useRemix.getState().zoom) + d]) return
      scale.current.anchor = (e.clientX - el.getBoundingClientRect().left + el.scrollLeft) / scale.current.ppb
      zoomStep(d)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Playback moves these straight in the DOM, on the shared frame loop while playing (no re-render per frame).
  const head = useRef<HTMLDivElement>(null)
  const now = useRef<HTMLSpanElement>(null)
  const flash = useRef<HTMLSpanElement>(null)
  const mapWin = useRef<HTMLSpanElement>(null)
  const mapHead = useRef<HTMLSpanElement>(null)
  const dragging = useRef(false)
  const live = useRef({ remix, marks, pxPerBeat, beats, isPlaying, last: -1 })
  live.current = { ...live.current, remix, marks, pxPerBeat, beats, isPlaying }
  function syncMap() {
    const el = view.current
    const w = mapWin.current
    if (!el || !w || !el.scrollWidth) return
    w.style.left = `${(el.scrollLeft / el.scrollWidth) * 100}%`
    w.style.width = `${(el.clientWidth / el.scrollWidth) * 100}%`
  }
  useEffect(() => {
    const paint = () => {
      const L = live.current
      const el = view.current
      const beat = secToBeat(visualTimeRef.current ?? 0, L.remix.bpm)
      const px = beat * L.pxPerBeat
      if (head.current) head.current.style.transform = `translateX(${px}px)`
      if (mapHead.current) mapHead.current.style.left = `${(beat / Math.max(1, L.beats)) * 100}%`
      const { follow, zoom: z } = useRemix.getState()
      // FOLLOW: keep the playhead between 12 % and 78 % of the view, easing there.
      if (el && L.isPlaying && follow && z > 1 && !dragging.current) {
        const at = px - el.scrollLeft
        if (at < el.clientWidth * 0.12 || at > el.clientWidth * 0.78) {
          el.scrollLeft += (px - el.clientWidth * 0.3 - el.scrollLeft) * 0.18
          syncMap()
        }
      }
      const bpb = L.remix.beats_per_bar
      const s = L.isPlaying
        ? L.remix.sections.find((x) => beat >= sectionBeat(x, bpb) && beat < sectionBeat(x, bpb) + x.bars * bpb)
        : undefined
      const n = now.current
      if (n) {
        n.style.display = s ? 'block' : 'none'
        if (s) {
          n.style.left = `${sectionBeat(s, bpb) * L.pxPerBeat}px`
          n.style.width = `${s.bars * bpb * L.pxPerBeat}px`
          n.style.setProperty('--c', SECTION_COLOUR[s.kind])
          n.toggleAttribute(
            'data-gap',
            L.marks.some((m) => (m.kind === 'gap' || m.kind === 'pause') && beat >= m.beat && beat < m.beat + m.beats),
          )
        }
      }
      // A drop's first hit, once a pass: a 1-bar ember flash through the lanes (a jump or a loop back doesn't count).
      const f = flash.current
      const hit =
        L.isPlaying && L.last >= 0 && beat - L.last < 1 && L.marks.find((m) => m.kind === 'first' && L.last < m.beat && beat >= m.beat)
      if (f && hit) {
        f.style.left = `${hit.beat * L.pxPerBeat}px`
        f.style.width = `${bpb * L.pxPerBeat}px`
        f.removeAttribute('data-on')
        void f.offsetWidth // restart the CSS animation
        f.setAttribute('data-on', '')
      }
      L.last = L.isPlaying ? beat : -1
    }
    paint()
    return isPlaying ? addFrame(paint) : undefined
  }, [isPlaying, currentTime, pxPerBeat, remix, marks, visualTimeRef])

  // On the lanes' empty space: a click moves the playhead there (and picks that lane), a drag selects clips (⇧ adds).
  const lanesRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<{ x0: number; y0: number; x1: number; y1: number; add: boolean; lane: string | null } | null>(null)
  const local = (e: ReactPointerEvent) => {
    const r = lanesRef.current!.getBoundingClientRect()
    return { x1: e.clientX - r.left, y1: e.clientY - r.top }
  }
  const marqueeUp = () => {
    const el = lanesRef.current
    if (!box || !el) return
    setBox(null)
    const [x0, x1, y0, y1] = [Math.min(box.x0, box.x1), Math.max(box.x0, box.x1), Math.min(box.y0, box.y1), Math.max(box.y0, box.y1)]
    if (readOnly || (x1 - x0 < 4 && y1 - y0 < 4)) {
      if (pxPerBeat) seekTo(beatToSec(Math.max(0, x0 / pxPerBeat), remix.bpm))
      return useRemix.setState({ clips: [], section: null, lane: readOnly ? null : box.lane })
    }
    const r = el.getBoundingClientRect()
    const hit = [...el.querySelectorAll<HTMLElement>('[data-clip]')].filter((c) => {
      const b = c.getBoundingClientRect()
      return b.right > r.left + x0 && b.left < r.left + x1 && b.bottom > r.top + y0 && b.top < r.top + y1
    })
    actions.selectClips(
      hit.map((c) => c.dataset.clip!),
      box.add,
    )
  }

  const unprepared = remix.lanes.reduce((n, l) => n + l.clips.filter((c) => !c.audio_id).length, 0)
  const status =
    progress?.label ??
    (plan ? PLAN[plan].status(remix.sections.filter((x) => x.kind === 'drop').length) : unprepared ? `PREPARING ${unprepared}` : '')
  const [loopA, loopB] = loopRegion(
    remix,
    useRemix((s) => s.loopBeats),
    section,
  )
  const loopOn = useRemix((s) => s.loopOn)
  const hi = (c: RemixClip) =>
    sel.some(
      (i) =>
        c.at_beat >= sectionBeat(remix.sections[i]!, bpb) &&
        c.at_beat < sectionBeat(remix.sections[i]!, bpb) + remix.sections[i]!.bars * bpb,
    )
  return (
    <section className={css.panel} aria-label="Remix timeline" data-testid="remix-timeline" data-original={readOnly || undefined}>
      <div className={css.head}>
        <span className={css.title}>TIMELINE</span>
        <span className={css.status} role="status" data-busy={progress ? '' : undefined} data-plan={(plan && !progress) || undefined}>
          {status}
        </span>
        <EditToolbar bars={Math.round(remixBeats(remix) / remix.beats_per_bar)} />
      </div>
      {sel.length > 0 && <SectionTools remix={remix} sel={sel} playBeat={playBeat} />}
      <KeysTooFar remix={remix} />
      <ShortcutsOverlay />
      <div className={css.body}>
        <div className={css.headCol}>
          <div className={css.headBar}>BAR</div>
          <div className={css.headSections}>SECTIONS {sel.length > 0 && <b>{sel.length} SEL</b>}</div>
          {lanes.map((l) => (
            <LaneHead key={l.id} remix={remix} lane={l} readOnly={readOnly} />
          ))}
        </div>
        <div ref={view} className={css.viewport} onScroll={syncMap}>
          <div className={css.tracks} style={{ width: beats * pxPerBeat }}>
            <BarRuler
              remix={remix}
              beats={beats}
              pxPerBeat={pxPerBeat}
              zoom={zoom}
              marks={marks}
              onSeek={(beat) => seekTo(beatToSec(beat, remix.bpm))}
            />
            <SectionLane
              key={`${remix.id}:${remix.seed}`}
              remix={remix}
              pxPerBeat={pxPerBeat}
              sel={sel}
              nowRef={now}
              dragging={dragging}
              readOnly={readOnly}
              plan={plan}
            />
            <div
              ref={lanesRef}
              className={css.lanes}
              onPointerDown={(e) => {
                const at = e.target as Element
                if (e.button !== 0 || (!readOnly && at.closest('[data-clip]'))) return
                e.currentTarget.setPointerCapture(e.pointerId)
                const p = local(e)
                const lane = at.closest('[data-lane-id]')?.getAttribute('data-lane-id')
                setBox({ x0: p.x1, y0: p.y1, ...p, add: e.shiftKey, lane: lane && !lane.startsWith('empty:') ? lane : null })
              }}
              onPointerMove={(e) => box && setBox({ ...box, ...local(e) })}
              onPointerUp={marqueeUp}
              onPointerCancel={() => setBox(null)}
            >
              {lanes.map((l, i) => (
                <StemLane key={l.id} remix={remix} lane={l} index={i} pxPerBeat={pxPerBeat} readOnly={readOnly} hi={hi} />
              ))}
              {box && (
                <div
                  className={css.marquee}
                  aria-hidden="true"
                  style={{
                    left: Math.min(box.x0, box.x1),
                    top: Math.min(box.y0, box.y1),
                    width: Math.abs(box.x1 - box.x0),
                    height: Math.abs(box.y1 - box.y0),
                  }}
                />
              )}
            </div>
            <div className={css.overlay} aria-hidden="true">
              {Array.from({ length: Math.floor((beats / bpb - 1) / 8) }, (_, k) => (k + 1) * 8).map((b) => (
                <span key={b} className={css.phrase} data-32={b % 32 === 0 || undefined} style={{ left: b * bpb * pxPerBeat }} />
              ))}
              {loopOn && <span className={css.loopBand} style={{ left: loopA * pxPerBeat, width: (loopB - loopA) * pxPerBeat }} />}
              {remix.sections.map(
                (x, i) =>
                  planned(plan, x) && (
                    <span
                      key={i}
                      className={css.planBand}
                      style={{ left: sectionBeat(x, bpb) * pxPerBeat, width: x.bars * bpb * pxPerBeat }}
                    />
                  ),
              )}
              <span ref={flash} className={css.flash} />
            </div>
            <div ref={head} className={css.playhead} aria-hidden="true" />
          </div>
        </div>
      </div>
      <Overview
        remix={remix}
        beats={beats}
        zoom={zoom}
        view={view}
        winRef={mapWin}
        headRef={mapHead}
        onSeek={(beat) => seekTo(beatToSec(beat, remix.bpm))}
      />
    </section>
  )
}

/** Under the head while sections are selected (never over the lanes): ◀ ▶ DUPLICATE SPLIT LOOP · CUT… · ESC. */
function SectionTools({ remix, sel, playBeat }: { remix: Remix; sel: number[]; playBeat(): number }) {
  const loopOn = useRemix((s) => s.loopOn)
  const [confirm, setConfirm] = useState(false)
  const key = sel.join()
  useEffect(() => {
    setConfirm(false)
  }, [key])
  useEffect(() => {
    if (!confirm) return
    const t = setTimeout(() => setConfirm(false), 3000)
    return () => clearTimeout(t)
  }, [confirm])
  const bpb = remix.beats_per_bar
  const move = (d: -1 | 1) => {
    const m = nudgeSections(remix, sel, d)
    if (m) actions.editSections(m.next, m.sel)
  }
  const dup = () => {
    const m = duplicateSections(remix, sel)
    actions.editSections(m.next, m.sel)
  }
  const split = () => {
    const m = splitSection(remix, playBeat())
    if (m) actions.editSections(m.next, [m.index])
  }
  // LOOP: the selected section (the transport's default), or the span of several.
  const span = (): [number, number] => {
    const ss = sel.map((i) => remix.sections[i]!)
    return [Math.min(...ss.map((s) => sectionBeat(s, bpb))), Math.max(...ss.map((s) => sectionBeat(s, bpb) + s.bars * bpb))]
  }
  const cut = () => {
    if (!confirm) return setConfirm(true)
    actions.editSections(cutSections(remix, sel), [])
  }
  const btn = css.btn
  return (
    <div className={css.sectionTools} role="toolbar" aria-label="Section tools">
      <strong>{sel.length > 1 ? `${sel.length} SELECTED` : sectionName(remix, sel[0]!)}</strong>
      <button
        type="button"
        className={btn}
        aria-label="Move earlier"
        aria-keyshortcuts="ArrowLeft"
        disabled={Math.min(...sel) === 0}
        onClick={() => move(-1)}
      >
        ◀
      </button>
      <button
        type="button"
        className={btn}
        aria-label="Move later"
        aria-keyshortcuts="ArrowRight"
        disabled={Math.max(...sel) === remix.sections.length - 1}
        onClick={() => move(1)}
      >
        ▶
      </button>
      <button type="button" className={btn} onClick={dup}>
        DUPLICATE
      </button>
      <button type="button" className={btn} onClick={split} title="Split the section under the playhead, on the nearest bar line">
        SPLIT
      </button>
      <button
        type="button"
        className={`${btn} ${loopOn ? css.toggleOn : ''}`}
        aria-pressed={loopOn}
        onClick={() => useRemix.setState((s) => ({ loopOn: !s.loopOn, loopBeats: sel.length > 1 ? span() : null }))}
      >
        LOOP
      </button>
      <span className={css.gap14} />
      <button
        type="button"
        className={css.cut}
        data-confirm={confirm || undefined}
        disabled={sel.length >= remix.sections.length}
        onClick={cut}
      >
        {confirm ? 'CONFIRM CUT' : 'CUT…'}
      </button>
      <button
        type="button"
        className={css.esc}
        aria-label="Deselect the sections"
        onClick={() => useRemix.setState({ section: null, sectionSel: [] })}
      >
        ESC
      </button>
    </div>
  )
}

/** MASHUP with B shifted more than 4 semitones: say so inline, with a way out (another match). */
function KeysTooFar({ remix }: { remix: Remix }) {
  const match = useRemix((s) => s.match) ?? remix.mash
  const st = match?.shift_st ?? 0
  if (remix.recipe !== 'mashup' || Math.abs(st) <= 4) return null
  return (
    <div className={css.keysFar} role="alert">
      <i aria-hidden="true">▲</i>
      <span>
        <b>{Math.abs(st)} ST APART.</b> B is shifted {st > 0 ? '+' : '−'}
        {Math.abs(st)} st to meet A: that far, it sounds chipmunked. A B closer in key works better.
      </span>
      <button type="button" className={css.btn} onClick={() => useRemix.setState({ panel: 'radar', panelMin: false, swapClip: null })}>
        FIND ANOTHER IN RADAR
      </button>
    </div>
  )
}

const MARK_LABEL: Record<DropMark['kind'], [string, string]> = {
  gap: ['▸', 'GAP ▸'],
  first: ['◆', '◆ FIRST HIT'],
  pause: ['‖', '‖ PAUSE'],
  switch: ['⇄', '⇄ SWITCH'],
}
const beatsText = (n: number) => `${n === 0.5 ? '½' : n} beat${n === 1 || n === 0.5 ? '' : 's'}`
function markTitle(m: DropMark): string {
  const d = `DROP ${m.drop + 1}`
  if (m.kind === 'gap') return `GAP: ${beatsText(m.beats)} of silence before ${d}`
  if (m.kind === 'first') return `FIRST HIT: ${d} lands, the hardest hit`
  if (m.kind === 'pause') return `PAUSE: ${beatsText(m.beats)} of silence in ${d}`
  return m.beats ? `SWITCH: a ${beatsText(m.beats)} switch-up into ${d}` : `SWITCH: the groove changes up in ${d}`
}

/**
 * A drop anatomy marker (GAP, FIRST HIT, PAUSE, SWITCH): a 14px tag at the foot of the ruler. At FIT only GAP and
 * FIRST HIT show, as glyphs. Read-only for now, but positioned on its own so it can be dragged later.
 */
export function DropMarker({ mark, left, detail }: { mark: DropMark; left: number; detail: boolean }) {
  return (
    <span className={css.mark} data-kind={mark.kind} style={{ left }} title={markTitle(mark)}>
      {MARK_LABEL[mark.kind][detail ? 1 : 0]}
    </span>
  )
}

/** Bar numbers and ticks (their detail follows the zoom), the loop, the drop markers. Click to seek, drag to loop. */
export function BarRuler({
  remix,
  beats,
  pxPerBeat,
  zoom,
  marks,
  onSeek,
}: {
  remix: Remix
  beats: number
  pxPerBeat: number
  zoom: number
  marks: DropMark[]
  onSeek(beat: number): void
}) {
  const bpb = remix.beats_per_bar
  const tickEvery = zoom < 2 ? 4 : 1
  const labelEvery = zoom >= 8 ? 1 : zoom >= 4 ? 4 : zoom >= 2 ? 8 : 16
  const ticks = rulerBars(beats, bpb, pickupBeats(remix), tickEvery)
  const snap = useRemix((s) => s.snap)
  const section = useRemix((s) => s.section)
  const loopOn = useRemix((s) => s.loopOn)
  const loopBeats = useRemix((s) => s.loopBeats)
  const down = useRef<{ x: number; beat: number } | null>(null)
  const [drag, setDrag] = useState<[number, number] | null>(null)
  const [a, b] = drag ?? loopRegion(remix, loopBeats, section)
  const beatAt = (e: ReactPointerEvent<HTMLElement>) =>
    pxPerBeat ? clamp(0, (e.clientX - e.currentTarget.getBoundingClientRect().left) / pxPerBeat, beats) : 0
  const end = () => {
    down.current = null
    setDrag(null)
  }
  return (
    <div
      className={css.ruler}
      aria-label="Bar ruler: click to move the playhead, drag to set the loop"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        down.current = { x: e.clientX, beat: beatAt(e) }
      }}
      onPointerMove={(e) => {
        const d = down.current
        if (!d || Math.abs(e.clientX - d.x) < 4) return
        const [x, y] = [snapBeat(d.beat, snap, bpb), snapBeat(beatAt(e), snap, bpb)]
        setDrag([Math.min(x, y), Math.max(x, y)])
      }}
      onPointerUp={(e) => {
        if (drag && drag[1] > drag[0]) useRemix.setState({ loopBeats: drag, loopOn: true })
        else if (down.current && !drag) onSeek(beatAt(e))
        end()
      }}
      onPointerCancel={end}
    >
      {ticks.map(([bar, beat]) => (
        <span key={bar} className={css.tick} data-phrase={bar % 8 === 0 || undefined} style={{ left: beat * pxPerBeat }} />
      ))}
      {ticks
        .filter(([bar]) => bar >= 0 && bar % labelEvery === 0)
        .map(([bar, beat]) => (
          <span key={bar} className={css.barNo} style={{ left: beat * pxPerBeat }}>
            {bar + 1}
          </span>
        ))}
      {(loopOn || drag) && <span className={css.loopBar} style={{ left: a * pxPerBeat, width: (b - a) * pxPerBeat }} aria-hidden="true" />}
      {marks
        .filter((m) => zoom >= 2 || m.kind === 'gap' || m.kind === 'first')
        .map((m) => (
          <DropMarker
            key={`${m.kind}${m.beat}`}
            mark={m}
            detail={zoom >= 2}
            left={(m.kind === 'gap' ? m.beat + m.beats : m.beat) * pxPerBeat}
          />
        ))}
    </div>
  )
}

/** Under the lanes: the length, a mini map of the sections, the view's window when zoomed and the playhead. Drag to scroll. */
function Overview(p: {
  remix: Remix
  beats: number
  zoom: number
  view: RefObject<HTMLDivElement | null>
  winRef: RefObject<HTMLSpanElement | null>
  headRef: RefObject<HTMLSpanElement | null>
  onSeek(beat: number): void
}) {
  const { remix, beats } = p
  const bpb = remix.beats_per_bar
  const go = (e: ReactPointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const f = clamp(0, (e.clientX - r.left) / r.width, 1)
    const el = p.view.current
    if (el) el.scrollLeft = f * el.scrollWidth - el.clientWidth / 2
    if (p.zoom === 1) p.onSeek(f * beats) // at FIT there's nothing to scroll: it moves the playhead
  }
  return (
    <div className={css.overview} aria-label="Overview">
      <span>
        {fmtLen(beatToSec(beats, remix.bpm))} · {Math.round(beats / bpb)} BARS
      </span>
      <div
        className={css.map}
        title="Drag to scroll · ⌘-scroll the timeline to zoom"
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.currentTarget.setPointerCapture(e.pointerId)
          go(e)
        }}
        onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && go(e)}
      >
        {remix.sections.map((s, i) => (
          <i
            key={i}
            style={
              {
                left: `${(sectionBeat(s, bpb) / beats) * 100}%`,
                width: `${((s.bars * bpb) / beats) * 100}%`,
                '--c': SECTION_COLOUR[s.kind],
              } as CSSProperties
            }
          />
        ))}
        {p.zoom > 1 && <span ref={p.winRef} className={css.mapWin} aria-hidden="true" />}
        <span ref={p.headRef} className={css.mapHead} aria-hidden="true" />
      </div>
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ sections

/** A section's identity across reorders (its source bars; a repeat counts up), so a moved block keeps its element. */
const blockKeys = (sections: RemixSection[]) => {
  const seen = new Map<string, number>()
  return sections.map((s) => {
    const k = `${s.kind}-${s.from_slot}-${s.from_start_bar}-${s.bars}`
    seen.set(k, (seen.get(k) ?? 0) + 1)
    return `${k}-${seen.get(k)}`
  })
}

/**
 * The section blocks. Click selects (⇧ adds), drag reorders: the block follows the pointer, the others slide aside
 * live and an amber line shows where it lands. ← → move the selection. Mounted per take: its blocks drop in, 230ms apart.
 */
export function SectionLane(p: {
  remix: Remix
  pxPerBeat: number
  sel: number[]
  nowRef: RefObject<HTMLSpanElement | null>
  dragging: RefObject<boolean>
  /** The ORIGINAL: blocks to look at, not to select or move. */
  readOnly: boolean
  plan?: RemixRecipe
}) {
  const { remix, pxPerBeat, sel } = p
  const bpb = remix.beats_per_bar
  const keys = blockKeys(remix.sections)
  const delays = useRef<Map<string, number> | null>(null)
  delays.current ??= new Map(keys.map((k, i) => [k, i * 230]))
  const down = useRef<{ i: number; x: number; shift: boolean } | null>(null)
  const [drag, setDrag] = useState<{ i: number; dx: number } | null>(null)

  // While dragging: where the others slide to (the order the drop would make) and the insertion point.
  const lefts = remix.sections.map((s) => sectionBeat(s, bpb))
  let order: number[] | null = null
  let insertAt: number | null = null
  if (drag && pxPerBeat) {
    const len = (k: number) => remix.sections[k]!.bars * bpb
    const mid = lefts[drag.i]! + drag.dx / pxPerBeat + len(drag.i) / 2
    const others = remix.sections.map((_, k) => k).filter((k) => k !== drag.i)
    order = others.toSpliced(others.filter((k) => lefts[k]! + len(k) / 2 < mid).length, 0, drag.i)
    let at = 0
    for (const k of order) {
      if (k === drag.i) insertAt = at
      else lefts[k] = at
      at += len(k)
    }
  }

  const select = (i: number, add: boolean) => {
    const next = add ? (sel.includes(i) ? sel.filter((x) => x !== i) : [...sel, i]) : sel.length === 1 && sel[0] === i ? [] : [i]
    useRemix.setState({ section: next.at(-1) ?? null, sectionSel: next, clips: [] })
  }
  const nudge = (i: number, d: -1 | 1) => {
    const m = nudgeSections(remix, sel.includes(i) ? sel : [i], d)
    if (m) actions.editSections(m.next, m.sel)
  }
  const up = () => {
    const d = down.current
    down.current = null
    p.dragging.current = false
    setDrag(null)
    if (!d) return
    if (!drag || !order) return select(d.i, d.shift)
    const to = order.indexOf(d.i)
    if (to !== d.i) actions.editSections(moveSection(remix, d.i, to), [to])
  }
  return (
    <div className={css.sectionLane} role="listbox" aria-label="Sections: drag to reorder" aria-multiselectable="true">
      {remix.sections.map((s, i) => (
        <SectionBlock
          key={keys[i]}
          remix={remix}
          index={i}
          left={lefts[i]! * pxPerBeat}
          width={s.bars * bpb * pxPerBeat}
          selected={sel.includes(i)}
          dx={drag?.i === i ? drag.dx : null}
          delay={delays.current!.get(keys[i]!) ?? 0}
          part={p.plan && (planned(p.plan, s) ? PLAN[p.plan].part : null)}
          onPointerDown={(e) => {
            if (e.button !== 0 || p.readOnly) return
            e.currentTarget.setPointerCapture(e.pointerId)
            down.current = { i, x: e.clientX, shift: e.shiftKey }
          }}
          onPointerMove={(e) => {
            const d = down.current
            if (!d || d.shift || (!drag && Math.abs(e.clientX - d.x) < 4)) return
            p.dragging.current = true
            setDrag({ i, dx: e.clientX - d.x })
          }}
          onPointerUp={up}
          onPointerCancel={() => {
            down.current = null
            p.dragging.current = false
            setDrag(null)
          }}
          onKeyDown={(e) => {
            if (p.readOnly) return
            if (e.key === 'Enter' || e.key === ' ') select(i, e.shiftKey)
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') nudge(i, e.key === 'ArrowLeft' ? -1 : 1)
            else return
            e.preventDefault()
            e.stopPropagation()
          }}
        />
      ))}
      <span ref={p.nowRef} className={css.now} aria-hidden="true" />
      {insertAt != null && <span className={css.insert} style={{ left: insertAt * pxPerBeat }} aria-hidden="true" />}
    </div>
  )
}

/**
 * One section: LED stripe, name, source, and the bar count when there's room for it. Before a BUILD a planned section is
 * dashed ember with its new part (NEW BASS), the rest fade back.
 */
export function SectionBlock(p: {
  remix: Remix
  index: number
  left: number
  width: number
  selected: boolean
  /** Being dragged: how far it has followed the pointer. */
  dx: number | null
  delay: number
  /** Before a BUILD: this section's new part (planned), or null (not planned). */
  part?: string | null
  onPointerDown(e: ReactPointerEvent<HTMLDivElement>): void
  onPointerMove(e: ReactPointerEvent<HTMLDivElement>): void
  onPointerUp(): void
  onPointerCancel(): void
  onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>): void
}) {
  const s = p.remix.sections[p.index]!
  const name = sectionName(p.remix, p.index)
  // The bar count only where it fits beside the name (Big Shoulders 14px ≈ 8.2px a letter, plus the stripe and gaps).
  const showBars = !p.part && p.width - 22 >= name.length * 8.2 + 26
  return (
    <div
      className={css.block}
      role="option"
      aria-selected={p.selected}
      aria-label={
        p.part
          ? `${name}: BUILD rebuilds this`
          : `${name}, ${s.bars} bars, from ${s.from_slot} bar ${s.from_start_bar}. Drag, or select and use the arrow keys.`
      }
      data-plan={p.part ? '' : p.part === null ? 'dim' : undefined}
      tabIndex={0}
      data-drag={p.dx != null || undefined}
      style={{ left: p.left, width: p.width, '--delay': `${p.delay}ms`, '--dx': `${p.dx ?? 0}px` } as CSSProperties}
      onPointerDown={p.onPointerDown}
      onPointerMove={p.onPointerMove}
      onPointerUp={p.onPointerUp}
      onPointerCancel={p.onPointerCancel}
      onKeyDown={p.onKeyDown}
    >
      <div>
        <span className={css.led} style={{ '--c': SECTION_COLOUR[s.kind] } as CSSProperties} aria-hidden="true" />
        <span className={css.blockTop}>
          <span className={css.blockName}>{name}</span>
          {showBars && <span className={css.blockBars}>{s.bars}</span>}
        </span>
        <span className={css.blockSrc}>{p.part ?? (s.from_slot === 'B' ? `B · ${s.from_start_bar}` : '')}</span>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------------------------------------ lanes

const setLane = (r: Remix, laneId: string, patch: (l: RemixLane) => RemixLane) =>
  actions.save({ lanes: r.lanes.map((l) => (l.id === laneId ? patch(l) : l)) })

const useLaneOpen = (remix: Remix, lane: RemixLane, original: boolean) =>
  useRemix((s) => laneOpen(lane, s.laneOpen, remix.recipe === 'mashup', original))
/** Muted, or another lane is soloed: the lane goes quiet (.35). */
const quiet = (r: Remix, lane: RemixLane) => lane.mute || (!lane.solo && r.lanes.some((l) => l.solo))
/**
 * A lane's label: its role, and in a MASHUP its slot; S2's first-hit lane (the drop's 2-beat 808 first hit, trap's
 * dive) says so.
 */
const laneName = (l: RemixLane, mash: boolean) =>
  `${l.id.startsWith('first_hit') ? 'FIRST HIT' : l.id === 'vocals-chops' ? 'VOCAL CHOPS' : l.id === 'original:mix' ? 'FULL MIX' : ROLE_LABEL[l.role]}${mash && l.slot ? ` · ${l.slot}` : ''}`
const laneSrc = (l: RemixLane) => (l.role === 'synth_bass' || l.role === 'kit' || l.role === 'top' ? 'fox' : (l.slot ?? 'A'))

/**
 * A lane's row in the header column: ▾, source dot, name, M and S; when it's the picked lane, SWAP ALL ▾ and its gain.
 * A placeholder row (a role the remix has no lane for) and the ORIGINAL are read-only: just ▾ and the name.
 */
function LaneHead({ remix, lane, readOnly }: { remix: Remix; lane: RemixLane; readOnly: boolean }) {
  const selected = useRemix((s) => s.lane === lane.id)
  const open = useLaneOpen(remix, lane, readOnly)
  const fixed = readOnly || isPlaceholder(lane)
  const [gain, setGain] = useState(lane.gain_db)
  useEffect(() => setGain(lane.gain_db), [lane.gain_db])
  const name = laneName(lane, remix.recipe === 'mashup')
  const commitGain = () => gain !== lane.gain_db && void setLane(remix, lane.id, (l) => ({ ...l, gain_db: gain }))
  const pick = () => useRemix.setState({ lane: selected ? null : lane.id })
  return (
    <div className={css.laneHead} aria-selected={selected} data-closed={!open || undefined}>
      <div className={css.laneRow}>
        <button
          type="button"
          className={css.caret}
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${name}${lane.clips.length ? '' : ` · ${EMPTY_HINT[lane.role] ?? 'EMPTY'}`}`}
          onClick={() => useRemix.setState((s) => ({ laneOpen: { ...s.laneOpen, [laneKey(lane)]: !open } }))}
        >
          ▾
        </button>
        <span className={css.dot} data-src={laneSrc(lane)} aria-hidden="true" />
        {fixed ? (
          <span className={css.laneName}>{name}</span>
        ) : (
          <>
            <button type="button" className={css.laneName} aria-pressed={selected} title={`Pick ${name}`} onClick={pick}>
              {name}
            </button>
            <button
              type="button"
              className={css.ms}
              aria-pressed={lane.mute}
              aria-label={`Mute ${name}`}
              onClick={() => setLane(remix, lane.id, (l) => ({ ...l, mute: !l.mute }))}
            >
              M
            </button>
            <button
              type="button"
              className={css.ms}
              data-solo=""
              aria-pressed={lane.solo}
              aria-label={`Solo ${name}`}
              onClick={() => setLane(remix, lane.id, (l) => ({ ...l, solo: !l.solo }))}
            >
              S
            </button>
          </>
        )}
      </div>
      {selected && open && !fixed && (
        <div className={css.laneCtl}>
          <SwapMenu remix={remix} lane={lane} />
          <input
            type="range"
            className={css.fader}
            min={-24}
            max={6}
            step={0.5}
            value={gain}
            aria-label={`${name} gain`}
            aria-valuetext={`${gain > 0 ? '+' : ''}${gain} dB`}
            title={`${gain > 0 ? '+' : ''}${gain.toFixed(1)} dB`}
            style={{ '--pct': `${((gain + 24) / 30) * 100}%` } as CSSProperties}
            onChange={(e) => setGain(Number(e.target.value))}
            onPointerUp={commitGain}
            onKeyUp={commitGain}
          />
        </div>
      )}
    </div>
  )
}

/** A clip's source for merging: the stem's slot, or the sound it plays. */
const srcKey = (c: RemixClip) =>
  c.src.kind === 'stem' ? `stem:${c.src.slot}:${c.shift_st}` : c.src.kind === 'groove' ? `groove:${c.src.patch_id}` : `kit:${c.src.kit_id}`

/**
 * A lane's clips. Neighbouring clips from the same source read as one strip: one tag for the run (a gap under a bar,
 * like a drop's pause, doesn't start a new one), and touching clips join with square corners and no border between.
 * Each clip stays its own target. A BASS clip under a SYNTH BASS clip in a drop is the held 808 there.
 */
export function StemLane(p: {
  remix: Remix
  lane: RemixLane
  index: number
  pxPerBeat: number
  readOnly: boolean
  hi(c: RemixClip): boolean
}) {
  const { remix, lane } = p
  const selected = useRemix((s) => s.lane === lane.id)
  const open = useLaneOpen(remix, lane, p.readOnly)
  const bpb = remix.beats_per_bar
  const synth = remix.lanes.filter((l) => l.role === 'synth_bass').flatMap((l) => l.clips)
  const drops = remix.sections.filter((s) => s.kind === 'drop').map((s) => [sectionBeat(s, bpb), sectionBeat(s, bpb) + s.bars * bpb])
  const held = (c: RemixClip) =>
    lane.role === 'bass' &&
    drops.some(([a, b]) => c.at_beat >= a! && c.at_beat < b!) &&
    synth.some((g) => g.at_beat < c.at_beat + c.beats && c.at_beat < g.at_beat + g.beats)
  const clips = [...lane.clips].sort((a, b) => a.at_beat - b.at_beat)
  /** The gap from a to b in beats, when they're the same source (else null). */
  const gap = (a: RemixClip | undefined, b: RemixClip | undefined) =>
    a && b && srcKey(a) === srcKey(b) && held(a) === held(b) ? b.at_beat - (a.at_beat + a.beats) : null
  const touch = (a: RemixClip | undefined, b: RemixClip | undefined) => Math.abs(gap(a, b) ?? 1) < 1e-6
  const run = (a: RemixClip | undefined, b: RemixClip | undefined) => {
    const g = gap(a, b)
    return g != null && g > -1e-6 && g < bpb
  }
  return (
    <div
      className={css.lane}
      data-lane-id={lane.id}
      aria-selected={selected}
      data-closed={!open || undefined}
      data-quiet={quiet(remix, lane) || undefined}
      role="listbox"
      aria-multiselectable="true"
      aria-label={`${laneName(lane, remix.recipe === 'mashup')} clips`}
    >
      {!lane.clips.length && <span className={css.hint}>{EMPTY_HINT[lane.role] ?? 'EMPTY'}</span>}
      {open &&
        clips.map((c, i) => (
          <Clip
            key={c.id}
            remix={remix}
            lane={lane}
            clip={c}
            pxPerBeat={p.pxPerBeat}
            delay={p.index * 50}
            held={held(c)}
            hi={p.hi(c)}
            readOnly={p.readOnly}
            tagged={!run(clips[i - 1], c)}
            joinPrev={touch(clips[i - 1], c)}
            joinNext={touch(c, clips[i + 1])}
          />
        ))}
    </div>
  )
}

const shortKit = (name: string) => name.replace('TR-808 · ', '808 · ').replace('FOXBOX KIT', 'FOX KIT')

/**
 * A clip: click selects it (⇧ adds) and, on a SYNTH BASS, BASS, DRUMS or KIT sound, docks SWAP SOUND in the context
 * panel; dragging moves the selection, snapped. Labels and badges show as the clip's real width allows.
 */
export function Clip(p: {
  remix: Remix
  lane: RemixLane
  clip: RemixClip
  pxPerBeat: number
  delay: number
  held: boolean
  hi: boolean
  /** The ORIGINAL: nothing to select or drag (a click moves the playhead, like empty lane space). */
  readOnly: boolean
  /** The first clip of its strip: it carries the tag and badges. */
  tagged: boolean
  joinPrev: boolean
  joinNext: boolean
}) {
  const { remix, lane, clip } = p
  const selected = useRemix((s) => s.clips.includes(clip.id))
  const drag = useRemix((s) => (s.clips.includes(clip.id) ? s.dragBeats : 0))
  const down = useRef<{ x: number; moved: boolean } | null>(null)
  const songs = useSongs().data
  const { patches, kits } = useSoundLibrary()
  const src = clip.src
  const slot = src.kind === 'kit' ? null : src.slot
  const srcBpm = src.kind === 'stem' ? songBpm(songs?.find((s) => s.id === remix.sources.find((x) => x.slot === slot)?.song_id)) : null
  const ratio = srcBpm ? remix.bpm / srcBpm : 1
  // A FIRST HIT is 2 beats: at FIT that's a few px, so it keeps a 14 px minimum and a ◆ while it's that narrow. A sung
  // phrase (the vocals lane's clips, 0.5-9 beats) keeps 5 px so it can be seen and dragged; chops sit edge to edge as a strip.
  const firstHit = lane.id.startsWith('first_hit')
  const phrase = lane.role === 'vocals' && lane.id !== 'vocals-chops' && !p.readOnly
  const px = Math.max(clip.beats * p.pxPerBeat, firstHit ? 14 : phrase ? 5 : 0)
  const sound =
    src.kind === 'groove'
      ? patchName(patches, src.patch_id)
      : src.kind === 'kit'
        ? (kits.find((k) => k.id === src.kit_id)?.name ?? src.kit_id)
        : null
  // Stems from A go untagged (the design's rule); B's say B, and the engine's clips name their sound.
  const tag =
    sound == null ? (src.kind === 'stem' && src.slot === 'B' ? 'B' : '') : src.kind === 'kit' && px < 130 ? shortKit(sound) : sound
  const badges =
    px < 112
      ? []
      : [
          ...(clip.shift_st ? [`${clip.shift_st > 0 ? '+' : ''}${clip.shift_st} st`] : []),
          ...(Math.abs(ratio - 1) > 0.005 ? [`${ratio.toFixed(2)}×`] : []),
          ...(p.held ? ['808 HELD'] : []),
        ]
  const swappable = src.kind !== 'stem' && lane.role !== 'top'
  const preparing = !clip.audio_id
  const title = `${sound ?? `${slot} · ${src.kind === 'stem' ? src.stem.toUpperCase() : ''}`} · ${clip.beats / remix.beats_per_bar} bars${swappable ? ' · click to swap its sound' : ''}`
  return (
    <div
      className={css.clip}
      role="option"
      aria-selected={selected}
      aria-label={title}
      title={title}
      data-clip={clip.id}
      data-state={preparing ? 'preparing' : 'ready'}
      data-src={sound == null ? (slot ?? 'A') : 'fox'}
      data-held={p.held || undefined}
      data-hi={p.hi || undefined}
      data-hit={firstHit || undefined}
      data-join-prev={p.joinPrev || undefined}
      data-join-next={p.joinNext || undefined}
      style={{ left: (clip.at_beat + drag) * p.pxPerBeat, width: px }}
      onPointerDown={(e) => {
        if (e.button !== 0 || p.readOnly) return
        if (e.shiftKey) return actions.selectClips([clip.id], true, lane.id)
        e.currentTarget.setPointerCapture(e.pointerId)
        down.current = { x: e.clientX, moved: false }
        if (!selected) actions.selectClips([clip.id], false, lane.id)
      }}
      onPointerMove={(e) => {
        const d = down.current
        if (!d || (!d.moved && Math.abs(e.clientX - d.x) < 4)) return
        d.moved = true
        const { snap } = useRemix.getState()
        const at = snapBeat(clip.at_beat + (e.clientX - d.x) / p.pxPerBeat, snap, remix.beats_per_bar)
        useRemix.setState({ dragBeats: Math.max(at, 0) - clip.at_beat })
      }}
      onPointerUp={() => {
        const d = down.current
        const delta = useRemix.getState().dragBeats
        down.current = null
        useRemix.setState({ dragBeats: 0 })
        if (d?.moved) actions.moveSelection(delta)
        else if (d) {
          actions.selectClips([clip.id], false, lane.id) // a click in a multi-selection picks just this one
          if (swappable) useRemix.setState({ swapClip: clip.id })
        }
      }}
      onPointerCancel={() => {
        down.current = null
        useRemix.setState({ dragBeats: 0 })
      }}
    >
      <div>
        <ClipWave remix={remix} lane={lane} clip={clip} held={p.held} delay={p.delay} />
        {firstHit && px < 40 && (
          <span className={css.hitGlyph} aria-hidden="true">
            ◆
          </span>
        )}
        {p.tagged && (tag || badges.length > 0) && (
          <span className={css.tags}>
            {tag && (
              <span className={css.tag} data-src={sound == null ? (slot ?? 'A') : 'fox'}>
                {tag}
              </span>
            )}
            {badges.map((b) => (
              <span key={b} className={css.badge}>
                {b}
              </span>
            ))}
          </span>
        )}
        {preparing && (
          <span className={css.prep} aria-hidden="true">
            <span>{px < 96 ? 'PREP' : 'PREPARING'}</span>
          </span>
        )}
        {selected && (
          <>
            <span className={css.trim} aria-hidden="true" />
            <span className={css.trim} aria-hidden="true" />
          </>
        )}
      </div>
    </div>
  )
}

/**
 * The clip's stepped-bar waveform from its own audio: bars (stems, kits), one block a bar (the held 808), sparse blips
 * (TOP); SYNTH BASS draws its groove's hits, so it shows (at .22) while it prepares too. It prints in when it arrives.
 */
function ClipWave({ remix, lane, clip, held, delay }: { remix: Remix; lane: RemixLane; clip: RemixClip; held: boolean; delay: number }) {
  const buffers = use(Buffers)
  const b = clip.audio_id ? buffers[clip.audio_id] : undefined
  const notes = useGrooveNotes(remix, clip.src, lane.role === 'synth_bass')
  const secs = beatToSec(clip.beats, remix.bpm)
  const bars = clip.beats / remix.beats_per_bar
  const d = useMemo(
    () =>
      notes?.length
        ? hitsPath(notes, clip.beats)
        : b
          ? wavePath(b, secs, bars, held ? 'held' : lane.role === 'top' ? 'blips' : 'bars')
          : '',
    [notes, b, secs, bars, held, lane.role, clip.beats],
  )
  if (!d) return null
  return (
    <svg
      key={clip.audio_id ?? 'hits'}
      className={css.wave}
      viewBox="0 0 100 20"
      preserveAspectRatio="none"
      aria-hidden="true"
      style={{ animationDelay: `${delay}ms` }}
    >
      <path d={d} />
    </svg>
  )
}

/** A groove's patch (PatchPicker) or a kit clip's kit (KitPicker); a pick swaps the clips `ids` in one undo step. */
function SoundPicker({ ids, src }: { ids: string[]; src: GrooveClipSrc | KitClipSrc }) {
  return src.kind === 'groove' ? (
    <PatchPicker value={src.patch_id} onPick={(patch_id) => actions.swapSound(ids, { patch_id })} />
  ) : (
    <KitPicker value={src.kit_id} onPick={(kit_id) => actions.swapSound(ids, { kit_id })} />
  )
}

/**
 * SWAP ALL ▾ on the picked lane (a light-dismiss popover, not a dialog): BASS → BASS DNA (the drops' bass re-played on
 * the patch), DRUMS → FLIP KIT, A ↔ B, and SOUND (every groove, or kit, clip on the lane on one patch / kit).
 */
export function SwapMenu({ remix, lane }: { remix: Remix; lane: RemixLane }) {
  const patchId = useRemix((s) => s.patchId)
  const id = useId()
  const menu = useRef<HTMLDivElement>(null)
  const anchor = `--swap${id.replace(/[^a-z0-9]/gi, '')}`
  const sound = lane.clips.find((c) => c.src.kind === 'groove') ?? lane.clips.find((c) => c.src.kind === 'kit')
  const other = lane.slot === 'A' ? 'B' : 'A'
  const hasOther = lane.slot && remix.sources.some((s) => s.slot === other)
  const done = () => menu.current?.hidePopover()
  const toBassDna = () => {
    done()
    const bpb = remix.beats_per_bar
    const drops = remix.sections.filter((s) => s.kind === 'drop')
    const inDrop = (c: RemixClip) => drops.find((s) => c.at_beat >= sectionBeat(s, bpb) && c.at_beat < sectionBeat(s, bpb) + s.bars * bpb)
    const moved = lane.clips.filter(inDrop)
    if (!moved.length) return
    const synth = remix.lanes.find((l) => l.role === 'synth_bass') ?? {
      id: `lane-synth-${Date.now().toString(36)}`,
      role: 'synth_bass' as const,
      slot: lane.slot,
      gain_db: 0,
      mute: false,
      solo: false,
      clips: [],
    }
    const groove = moved.map((c): RemixClip => {
      const s = inDrop(c)!
      return {
        ...c,
        id: `${c.id}-dna`,
        src: {
          kind: 'groove',
          slot: lane.slot ?? 'A',
          start_bar: s.from_start_bar,
          bars: s.bars,
          patch_id: remix.bass_patch_id ?? patchId,
        },
        shift_st: 0,
        audio_id: null,
      }
    })
    const lanes = remix.lanes.map((l) =>
      l.id === lane.id
        ? { ...l, clips: l.clips.filter((c) => !inDrop(c)) }
        : l.id === synth.id
          ? { ...l, clips: [...l.clips, ...groove] }
          : l,
    )
    if (!remix.lanes.includes(synth as RemixLane)) lanes.push({ ...synth, clips: groove })
    void actions.save({ lanes, bass_patch_id: remix.bass_patch_id ?? patchId }).then(actions.prepare)
  }
  const fromOther = () => {
    done()
    void actions
      .save({
        lanes: remix.lanes.map((l) =>
          l.id === lane.id
            ? {
                ...l,
                slot: other,
                clips: l.clips.map((c) => (c.src.kind === 'kit' ? c : { ...c, src: { ...c.src, slot: other }, audio_id: null })),
              }
            : l,
        ),
      })
      .then(actions.prepare)
  }
  return (
    <>
      <button
        type="button"
        className={css.swapBtn}
        popoverTarget={id}
        style={{ anchorName: anchor }}
        aria-haspopup="menu"
        title="Swap every clip on this lane"
      >
        SWAP ALL ▾
      </button>
      <div
        ref={menu}
        id={id}
        popover="auto"
        className={css.swapMenu}
        role="menu"
        aria-label={`Swap every ${ROLE_LABEL[lane.role]} clip`}
        style={{ positionAnchor: anchor }}
      >
        <strong>SWAP EVERY {ROLE_LABEL[lane.role]} CLIP</strong>
        {lane.role === 'bass' && (
          <button type="button" role="menuitem" onClick={toBassDna}>
            BASS → BASS DNA
          </button>
        )}
        {lane.role === 'drums' && (
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              done()
              actions.setRecipe('flip')
            }}
            title="Pick a style in GENRE FLIP, then BUILD"
          >
            DRUMS → FLIP KIT
          </button>
        )}
        {hasOther && (
          <button type="button" role="menuitem" onClick={fromOther}>
            {ROLE_LABEL[lane.role]} → FROM {other}
          </button>
        )}
        {sound && sound.src.kind !== 'stem' && (
          <>
            <p>SOUND → EVERY CLIP ON THIS LANE</p>
            <SoundPicker ids={lane.clips.filter((c) => c.src.kind === sound.src.kind).map((c) => c.id)} src={sound.src} />
          </>
        )}
        {lane.role !== 'bass' && lane.role !== 'drums' && !hasOther && !sound && <p>NO SWAPS FOR THIS LANE</p>}
      </div>
    </>
  )
}
