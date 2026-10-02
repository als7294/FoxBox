import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ErrorBoundary } from '@/components/common/ErrorBoundary'
import { usePresets, useRack } from '@/api/queries'
import { MACRO_IDS, type MacroId, type Preset } from '@/api/types'
import {
  LiveEngine,
  liveParams,
  MidiMap,
  saveToLibrary,
  SetRecorder,
  SongDeck,
  type LatencyMode,
  type LiveTrigger,
  type MidiBinding,
  type MidiTarget,
  type Quantize,
  type SetRecording,
} from '@/audio/live'
import type { LiveInput } from '@/audio/live/input'
import { click } from '@/audio/recorder'
import { SaveClip } from '@/components/clips/SaveClip'
import { Button } from '@/components/common/Button'
import common from '@/components/common/common.module.css'
import { Screen } from '@/components/layout/Screen'
import { LiveMeters } from '@/components/live/LiveMeters'
import { LiveSongStrip } from '@/components/live/LiveSongStrip'
import styles from '@/components/live/live.module.css'
import { orderPresets } from '@/components/rack/PresetStrip'
import { Segmented } from '@/components/rack/Segmented'
import { addTake, setTakeShortcut } from '@/components/source/takes'
import { AudioSourceStrip } from '@/components/visuals/AudioSourceStrip'
import { faceShowsNow, LayerStack } from '@/components/visuals/LayerStack'
import { LiveInputControls } from '@/components/visuals/LiveInputControls'
import { LiveRecord } from '@/components/visuals/LiveRecord'
import { clipAudioFor, loadPrefs, savePrefs, setClipAudio, voiceOpen, type AudioSource } from '@/components/visuals/page'
import { StemsRow } from '@/components/visuals/StemsRow'
import { useStageFrameReader } from '@/components/visuals/stageFrame'
import { VisualsStage } from '@/components/visuals/VisualsStage'
import { bridge } from '@/env'
import { useSong } from '@/state/song'
import { studio, useStudio } from '@/state/studio'
import { isTalking, ledsLit, sourceLevel, useLiveAudio, type TalkMode } from '@/state/liveAudio'
import { useLiveDeck } from '@/state/liveDeck'
import { toast } from '@/state/toasts'
import { useUi } from '@/state/ui'
import { useVisualsUi, visualsUi } from '@/state/visualsUi'

type Status = 'off' | 'starting' | 'on' | 'error'
type TakeState = 'idle' | 'count' | 'rec'

const FX: { name: LiveTrigger; label: string; key: string }[] = [
  { name: 'throw', label: 'THROW', key: 'a' },
  { name: 'stutter', label: 'STUTTER', key: 's' },
  { name: 'swell', label: 'SWELL', key: 'd' },
  { name: 'tapestop', label: 'TAPE STOP', key: 'f' },
  { name: 'dropout', label: 'DROP OUT', key: 'g' },
]
const MACRO_LABEL: Record<MacroId, string> = { depth: 'DEPTH', grit: 'GRIT', machine: 'MACHINE', space: 'SPACE' }
/** Talk off with no input mute on the engine (S2's setTalk): the output is held this far down. */
const MUTED_DB = -120

/** AudioContext.setSinkId (Chromium 110+), not in every DOM lib yet. */
type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const COUNT_IN_BEATS = 3
/** Output device names that sound like headphones (no feedback warning for these). */
const HEADPHONES = /head(phone|set)|ear(phone|bud)|airpods|buds|in-ear|iem/i
const bindingText = (b: MidiBinding | undefined) => (b ? `${b.kind === 'cc' ? 'CC' : 'N'}${b.number}` : null)
/** The header's IN: the source's peak (the deck, the live input or the mic) as a share of its 12 LEDs. */
const sourceLeds = () => ledsLit(sourceLevel().peak, 12) / 12

/**
 * VISUALS (1.5.2, app/design/visuals-td §A; the screen id stays 'live'): the picture first. The AudioSourceStrip
 * header (TRACK: the song deck and its stems · LIVE INPUT · MIC: the voice mask's devices, in the SOURCE row under it),
 * LAYERS on the left (S4's compositor scene: face hiding, the text, the effects, the base), the stage on the right
 * with its bar, drawers (effects, clips) and PERFORM, and under it VOICE: the voice mask laid out to perform. The mic
 * goes through S2's live rack (audio/live) with the Studio's preset and macros: preset pads, BPM-quantised FX pads
 * (S2's triggers, on the session grid), four macros, push-to-talk, MIDI learn for all of them (S2's MidiMap),
 * recording the set (S2's SetRecorder) and TAKE → STUDIO. Source, latency and talk state are S2's useLiveAudio.
 */
export function LiveScreen() {
  const [status, setStatus] = useState<Status>('off')
  const [error, setError] = useState<string | null>(null)
  const onPage = useUi((u) => u.screen === 'live')
  useStageFrameReader(onPage)
  const [live, setLive] = useState<LiveEngine | null>(null)
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([])
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([])
  const [inputId, setInputId] = useState('')
  /** Whether the running engine has the mic (TRACK starts without it). */
  const [micOpen, setMicOpen] = useState(false)
  const [outputId, setOutputId] = useState('')
  const latencyMode = useLiveAudio((s) => s.latency)
  const [latency, setLatency] = useState<number | null>(null)
  const [quantize, setQuantize] = useState<Quantize | 'auto'>('auto')
  const [firing, setFiring] = useState<Partial<Record<LiveTrigger, boolean>>>({})
  // The source, latency and talk state live in useLiveAudio (S5's AudioSourceStrip and VOICE strip set them too).
  const talkMode = useLiveAudio((s) => s.talkMode)
  const muted = useLiveAudio((s) => s.muted)
  const held = useLiveAudio((s) => s.held)
  const talking = useLiveAudio(isTalking)
  const { setTalkMode, setMuted, talk } = useLiveAudio.getState()
  // TAKE → STUDIO: a dry take with a count-in, sent to the Studio as its source
  const [takeState, setTakeState] = useState<TakeState>('idle')
  const takeRec = useRef<SetRecorder | null>(null)
  const countTimer = useRef<number | null>(null)
  // MIDI learn
  const [midi, setMidi] = useState<MidiMap | null>(null)
  const [learning, setLearning] = useState(false)
  const [learnTarget, setLearnTarget] = useState<MidiTarget | null>(null)
  const [, setBindingsRev] = useState(0)
  // The set recording
  const setRec = useRef<SetRecorder | null>(null)
  const [setT0, setSetT0] = useState<number | null>(null)
  const [setNow, setSetNow] = useState(0)
  const [lastSet, setLastSet] = useState<(SetRecording & { url: string }) | null>(null)
  // The song deck: the Studio's song, playing under the voice in the live context (S2's SongDeck).
  const song = useSong((s) => s.song)
  const [deck, setDeck] = useState<SongDeck | null>(null)
  // PROD's music block plays the same TRACK.
  useEffect(() => useLiveDeck.setState({ deck }), [deck])
  const [songLevel, setSongLevel] = useState(0)
  const [songDuck, setSongDuck] = useState(true)
  // The page's remembered choices: the audio source, and VOICE open or closed (per source).
  const [prefs, setPrefs] = useState(loadPrefs)
  const source = useLiveAudio((s) => s.source)
  useEffect(() => savePrefs({ ...prefs, source }), [prefs, source])
  const voiceIsOpen = voiceOpen(prefs, source)
  const sourceOpen = prefs.sourceOpen !== false
  // TRACK plays the song through the live engine with the mic muted (MUTE here, so VOICE can open it again).
  // LIVE INPUT while it listens (its controls own it; leaving LIVE INPUT closes it).
  const [liveInput, setLiveInput] = useState<LiveInput | null>(null)
  // A clip of the stage records the active source's sound (getClipAudio); REC LIVE films the stage's canvas.
  const clipAudio = clipAudioFor(source, live?.bus ?? null, liveInput)
  useEffect(() => {
    setClipAudio(clipAudioFor(source, live?.bus ?? null, liveInput))
    return () => setClipAudio(null)
  }, [source, live, liveInput])
  const stageCanvas = useRef<HTMLCanvasElement | null>(null)

  const liveRef = useRef<LiveEngine | null>(null)
  liveRef.current = live

  const presets = orderPresets(usePresets().data ?? [])
  const presetsRef = useRef(presets)
  presetsRef.current = presets
  const rack = useRack().data
  const chain = useStudio((s) => s.chain)
  const macros = useStudio((s) => s.macros)
  const macroMap = useStudio((s) => s.macroMap)
  const key = useStudio((s) => s.key)
  const bpm = useStudio((s) => s.bpm)
  const presetId = useStudio((s) => s.presetId)
  const presetName = useStudio((s) => s.presetName)

  const refreshDevices = useCallback(async () => {
    try {
      const all = (await navigator.mediaDevices?.enumerateDevices()) ?? []
      setInputs(all.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default'))
      setOutputs(all.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default' && d.deviceId !== 'communications'))
    } catch {
      // no device list: the system defaults are used
    }
  }, [])
  useEffect(() => {
    void refreshDevices()
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices)
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices)
  }, [refreshDevices])

  // The rack follows the Studio's preset, macros and key; the grid follows its BPM.
  useEffect(() => {
    live?.apply(liveParams({ chain, macros, macroMap, modules: rack?.modules, key }))
  }, [live, chain, macros, macroMap, rack, key])
  useEffect(() => live?.setTempo(bpm), [live, bpm])

  // No song: STRINGS' TEST BEAT, if asked for (a song loading takes over).
  const testBeat = useLiveDeck((d) => d.testBeat) && !song
  useEffect(() => {
    if (song) useLiveDeck.setState({ testBeat: false })
  }, [song?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!live || (!song && !testBeat)) return setDeck(null)
    const d = new SongDeck(live)
    let alive = true
    ;(song ? d.load(song) : Promise.resolve(d.loadTestBeat())).then(
      () => alive && setDeck(d),
      (e: Error) => alive && toast.error('SONG NOT LOADED', { detail: e.message }),
    )
    return () => {
      alive = false
      setDeck(null)
      d.stop()
      d.dispose()
    }
    // A new song (not a new analysis or override of the same one: refreshGrid below takes those).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, song?.id, testBeat])
  useEffect(() => {
    if (deck && song) deck.refreshGrid(song)
  }, [deck, song])
  useEffect(() => deck?.setLevel(songLevel), [deck, songLevel])
  useEffect(() => deck?.setDuck(songDuck ? -6 : null), [deck, songDuck])

  // The round trip, as the performer feels it.
  useEffect(() => {
    if (!live) return setLatency(null)
    const tick = () => setLatency(live.latencyMs())
    tick()
    const t = window.setInterval(tick, 500)
    return () => window.clearInterval(t)
  }, [live, latencyMode])

  // Pads light up when their FX lands on the grid, for as long as it runs.
  useEffect(() => {
    if (!live) return
    const timers: number[] = []
    const off = live.bus.triggers('*', (ev) => {
      const wait = Math.max(0, (ev.at - live.ctx.currentTime) * 1000)
      timers.push(window.setTimeout(() => setFiring((f) => ({ ...f, [ev.name]: true })), wait))
      timers.push(window.setTimeout(() => setFiring((f) => ({ ...f, [ev.name]: false })), wait + Math.max(120, ev.durS * 1000)))
    })
    return () => {
      off()
      timers.forEach((t) => window.clearTimeout(t))
    }
  }, [live])

  // Talk: open mic, push-to-talk (held), or latched; MUTE over all of them. With S2's setTalk the mic closes and the
  // mask's tails ring on; without it the output is held down.
  useEffect(() => {
    const l = live as (LiveEngine & { setTalk?: (on: boolean) => void }) | null
    if (!l) return
    if (l.setTalk) l.setTalk(talking)
    else l.setOutputGain(talking ? 0 : MUTED_DB)
  }, [live, talking])

  const fire = useCallback(
    (name: LiveTrigger) => {
      liveRef.current?.trigger(name, quantize === 'auto' ? {} : { quantize })
    },
    [quantize],
  )

  const start = async () => {
    setError(null)
    setStatus('starting')
    try {
      const b = bridge()
      // TRACK plays the song without the mic; it opens only when the DJ arms it (picks MIC, or ARM MIC in VOICE).
      if (b && source !== 'track' && !(await b.askMicAccess())) throw new Error('Microphone access is off for FoxBox.')
      const engine = await LiveEngine.create({
        input: source === 'track' ? 'none' : 'mic',
        deviceId: inputId || undefined,
        latency: latencyMode,
        bpm: useStudio.getState().bpm,
      })
      if (outputId) await (engine.ctx as SinkContext).setSinkId?.(outputId)
      setLive(engine)
      setMicOpen(engine.input !== 'none')
      setStatus('on')
      void refreshDevices() // labels arrive once the mic is allowed
    } catch (e) {
      setStatus('error')
      setError((e as Error).message)
    }
  }
  // PROD's ▶ PLAY starts the TRACK engine (no mic) the way START TRACK does, when VISUALS is on TRACK and it's off.
  const startRef = useRef(start)
  startRef.current = start
  const canStartTrack = source === 'track' && (Boolean(song) || testBeat) && (status === 'off' || status === 'error')
  useEffect(() => useLiveDeck.setState({ startTrack: canStartTrack ? () => void startRef.current() : null }), [canStartTrack])
  const stop = async () => {
    const l = liveRef.current
    setRec.current?.release()
    setRec.current = null
    takeRec.current?.release()
    takeRec.current = null
    if (countTimer.current) window.clearTimeout(countTimer.current)
    setTakeState('idle')
    setSetT0(null)
    setLive(null)
    setMicOpen(false)
    setStatus('off')
    await l?.close()
  }
  useEffect(
    () => () => {
      setRec.current?.release()
      takeRec.current?.release()
      if (countTimer.current) window.clearTimeout(countTimer.current)
      void liveRef.current?.close()
    },
    [],
  )

  // MIDI: one map for the page; its actions drive the same controls as the mouse and keys.
  useEffect(() => {
    let alive = true
    let m: MidiMap | null = null
    MidiMap.create().then(
      (x) => {
        if (!alive) return x.dispose()
        m = x
        setMidi(x)
      },
      () => {}, // no Web MIDI (or refused): the learn button stays off
    )
    return () => {
      alive = false
      m?.dispose()
    }
  }, [])
  useEffect(
    () =>
      midi?.onAction((a) => {
        if (a.type === 'pad') fire(a.pad as LiveTrigger)
        else if (a.type === 'macro') studio.setMacro(a.macro, a.value)
        else if (a.type === 'ptt') talk(a.down)
        else if ('index' in a) {
          const p = presetsRef.current[a.index]
          if (p) studio.applyPreset(p)
        } else {
          const list = presetsRef.current
          const i = list.findIndex((p) => p.id === useStudio.getState().presetId)
          const p = list[(i + a.step + list.length) % list.length]
          if (p) studio.applyPreset(p)
        }
      }),
    [midi, fire, talk],
  )
  /** In MIDI learn, a click binds the control to the next knob or pad moved; otherwise it just acts. */
  const learnOr = (target: MidiTarget, act: () => void) => () => {
    if (!learning || !midi) return act()
    setLearnTarget(target)
    void midi.learn(target).then(() => {
      setLearnTarget(null)
      setBindingsRev((n) => n + 1)
    })
  }
  const badge = (target: MidiTarget): ReactNode => {
    if (!learning) return null
    const text = learnTarget === target ? 'MOVE A CONTROL…' : (bindingText(midi?.bindings()[target]) ?? 'LEARN')
    return (
      <span className={styles.midiBadge} data-waiting={learnTarget === target || undefined}>
        {text}
      </span>
    )
  }

  // Keys on this screen: Space holds push-to-talk; A S D F G fire the FX pads (1–7 stay the preset keys).
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (useUi.getState().screen !== 'live' || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.target instanceof Element && e.target.closest('input, select, textarea')) return
      if (e.key === ' ') {
        e.preventDefault()
        if (!e.repeat) talk(true)
        return
      }
      // PERFORM's pads own A, D and F (and the rest of the letters) while it's open.
      const fx = useVisualsUi.getState().perform ? undefined : FX.find((f) => f.key === e.key.toLowerCase())
      if (fx && !e.repeat) {
        e.preventDefault()
        fire(fx.name)
      }
    }
    const onUp = (e: KeyboardEvent) => {
      if (e.key === ' ' && useUi.getState().screen === 'live') talk(false)
    }
    window.addEventListener('keydown', onDown, true)
    window.addEventListener('keyup', onUp, true)
    return () => {
      window.removeEventListener('keydown', onDown, true)
      window.removeEventListener('keyup', onUp, true)
    }
  }, [fire, talk])

  // The set: everything that comes out of the mask, from REC SET to STOP.
  useEffect(() => {
    if (setT0 == null) return
    const t = window.setInterval(() => setSetNow(Date.now()), 250)
    return () => window.clearInterval(t)
  }, [setT0])
  useEffect(() => () => void (lastSet && URL.revokeObjectURL(lastSet.url)), [lastSet])
  const recordSet = async () => {
    if (!live) return
    if (setRec.current) {
      const r = setRec.current
      setRec.current = null
      setSetT0(null)
      const out = await r.stop()
      setLastSet({ ...out, url: URL.createObjectURL(out.blob) })
      if (out.truncated) toast.warn('SET TRUNCATED', { detail: 'It reached the longest a set can be; the rest was not kept.' })
      return
    }
    const r = new SetRecorder(live.bus)
    r.start()
    setRec.current = r
    setLastSet(null)
    setSetT0(Date.now())
    setSetNow(Date.now())
  }
  // TAKE → STUDIO: the count-in on the session tempo, then the dry mic until TAKE again; the take goes to the engine
  // as a recording (clean-up, transcript) and opens in the Studio as its source, as RECORD always did.
  const toggleTake = useCallback(async () => {
    const l = liveRef.current
    if (!l) return
    if (takeState === 'count') {
      if (countTimer.current) window.clearTimeout(countTimer.current)
      countTimer.current = null
      return setTakeState('idle')
    }
    if (takeState === 'rec') {
      const r = takeRec.current
      takeRec.current = null
      setTakeState('idle')
      const out = await r?.stop()
      if (!out?.dry) return
      const buf = await l.ctx.decodeAudioData(await out.dry.arrayBuffer())
      const take = addTake({ sampleRate: buf.sampleRate, channels: [buf.getChannelData(0)] })
      if (!take) return
      studio.setTab('record')
      studio.selectTake(take.id)
      useUi.getState().navigate('studio')
      toast.success(`${take.name} → STUDIO`, { detail: `${take.durationS.toFixed(2)} s · transcribing` })
      return
    }
    const beat = 60 / useStudio.getState().bpm
    const t0 = l.ctx.currentTime + 0.05
    for (let i = 0; i < COUNT_IN_BEATS; i++) click(l.ctx, t0 + i * beat, i === 0)
    setTakeState('count')
    countTimer.current = window.setTimeout(
      () => {
        countTimer.current = null
        const r = new SetRecorder(l.bus, { dry: true })
        r.start()
        takeRec.current = r
        setTakeState('rec')
      },
      COUNT_IN_BEATS * beat * 1000 + 50,
    )
  }, [takeState])
  useEffect(() => {
    setTakeShortcut(() => void toggleTake())
    return () => setTakeShortcut(null)
  }, [toggleTake])

  const addSetToVault = async () => {
    if (!lastSet) return
    try {
      await saveToLibrary(lastSet)
      toast.success('SET IN THE VAULT', { detail: lastSet.filename })
    } catch (e) {
      toast.error('NOT SAVED', { detail: (e as Error).message })
    }
  }

  const on = status === 'on'
  const outputLabel = outputId ? (outputs.find((d) => d.deviceId === outputId)?.label ?? '') : ''
  const headphones = HEADPHONES.test(outputLabel)
  const onOutput = async (id: string) => {
    setOutputId(id)
    try {
      if (live) await (live.ctx as SinkContext).setSinkId?.(id)
    } catch (e) {
      toast.error('OUTPUT NOT CHANGED', { detail: (e as Error).message })
    }
  }
  const onInput = async (id: string) => {
    setInputId(id)
    if (live) {
      await stop()
      toast.info('INPUT CHANGED', { detail: 'Go live again to use it.' })
    }
  }
  const onLatency = (mode: LatencyMode) => useLiveAudio.getState().setLatency(mode)
  // From here or S5's strip: the running engine follows.
  useEffect(() => void liveRef.current?.setLatencyMode(latencyMode), [latencyMode])
  /** A running engine started for TRACK has no mic: open it only when the DJ arms it (MIC source, or ARM MIC). */
  const ensureMic = async () => {
    const engine = liveRef.current
    if (!engine || engine.input !== 'none') return
    const b = bridge()
    if (b && !(await b.askMicAccess())) return setError('Microphone access is off for FoxBox.')
    await engine.setInput('mic', inputId || undefined)
    setMicOpen(engine.input !== 'none')
    void refreshDevices()
  }
  /** Disarms: the mic closes, the song and the rack keep running (clips then carry the track alone). */
  const closeMic = async () => {
    const engine = liveRef.current
    if (!engine || engine.input === 'none') return
    await engine.setInput('none')
    setMicOpen(false)
  }
  const onSource = (next: AudioSource) => useLiveAudio.getState().setSource(next)
  // From here or S5's strip: MIC arms the mic, the others close it.
  useEffect(() => void (source === 'mic' ? ensureMic() : closeMic()), [source]) // eslint-disable-line react-hooks/exhaustive-deps
  const toggleVoice = () => setPrefs((p) => ({ ...p, voice: { ...p.voice, [source]: !voiceOpen(p, source) } }))
  // What the strips read: the engine's state and the taps behind sourceLevel() / micLevel().
  useEffect(() => {
    const mic = micOpen ? (live?.bus.input ?? null) : null
    useLiveAudio.setState({ on, micOpen, taps: { track: deck?.tap.analyser ?? null, input: liveInput?.tap.analyser ?? null, mic } })
  }, [on, micOpen, live, deck, liveInput])
  useEffect(() => () => useLiveAudio.setState({ on: false, micOpen: false, taps: { track: null, input: null, mic: null } }), [])
  const talkText =
    on && !micOpen
      ? 'MIC OFF'
      : muted
        ? 'MUTED'
        : talkMode === 'open'
          ? on
            ? 'MIC OPEN'
            : 'MIC'
          : talking
            ? 'TALKING'
            : talkMode === 'ptt'
              ? 'HOLD TO TALK'
              : 'TAP TO TALK'

  return (
    <Screen className={styles.screen} data-testid="live-screen" data-learning={learning || undefined}>
      <AudioSourceStrip
        source={source}
        onSource={onSource}
        status={status}
        latency={latency}
        latencyMode={latencyMode}
        onLatency={onLatency}
        onStart={() => void start()}
        onStop={() => void stop()}
        startDisabled={status === 'starting' || (source === 'track' && !song)}
        startTitle={
          source === 'track' ? (song ? 'Play the song here (the mic stays off)' : 'Pick or drop a song first') : 'Open the mic through the mask'
        }
        headphones={source === 'mic' && !headphones}
        level={sourceLeds}
        open={sourceOpen}
        onToggle={() => setPrefs((p) => ({ ...p, sourceOpen: !sourceOpen }))}
      />
      {error && <p className={styles.error}>{error}</p>}
      {/* The source's own controls; hidden, never unmounted (LIVE INPUT keeps listening). */}
      <section className={styles.sourceRow} aria-label="Audio source controls" hidden={!sourceOpen} data-source={source}>
        {source === 'track' ? (
          <>
            <LiveSongStrip deck={deck} level={songLevel} duck={songDuck} onLevel={setSongLevel} onDuck={setSongDuck} />
            {song && <StemsRow song={song} />}
          </>
        ) : source === 'input' ? (
          <LiveInputControls onInput={setLiveInput} />
        ) : (
          <>
            <label className={styles.field}>
              <span>INPUT</span>
              <select value={inputId} onChange={(e) => void onInput(e.target.value)}>
                <option value="">DEFAULT INPUT</option>
                {inputs.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `MICROPHONE ${i + 1}`}
                  </option>
                ))}
              </select>
            </label>
            <label className={styles.field}>
              <span>OUTPUT</span>
              <select value={outputId} onChange={(e) => void onOutput(e.target.value)}>
                <option value="">SYSTEM OUTPUT</option>
                {outputs.map((d, i) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || `OUTPUT ${i + 1}`}
                  </option>
                ))}
              </select>
            </label>
            <p className={styles.hint}>Use headphones: the mask comes back through the output while you talk.</p>
          </>
        )}
      </section>

      <div className={styles.grid}>
        <aside className={styles.side} aria-label="Layers">
          <ErrorBoundary scope="LAYERS" compact>
            <LayerStack stemsLive={source === 'input' && Boolean(liveInput)} />
          </ErrorBoundary>
        </aside>

        <div className={styles.stage}>
          <ErrorBoundary scope="STAGE" compact>
            <VisualsStage
              bus={live?.bus ?? null}
              deck={deck}
              input={source === 'input' ? liveInput : null}
              bpm={bpm}
              onCanvas={(c) => (stageCanvas.current = c)}
              voice={{ talk, lit: talking, ready: on && micOpen }}
              clips={
                <>
                  <SaveClip confirm={(render) => (faceShowsNow() ? visualsUi.askFace('clip', render) : render())} />
                  <LiveRecord stage={() => stageCanvas.current} audioReady={clipAudio != null} deck={source === 'track' ? deck : null} />
                </>
              }
            />
          </ErrorBoundary>
        </div>

        {/* VOICE under the stage: the head (mode, mic, preset, PUSH, MUTE, TAKE, REC SET) always, the rack open. */}
        <section className={styles.voice} aria-label="Voice" data-testid="visuals-voice" data-open={voiceIsOpen || undefined}>
          <div className={styles.voiceHead}>
            <button type="button" className={styles.voiceToggle} aria-expanded={voiceIsOpen} onClick={toggleVoice}>
              <span aria-hidden className={styles.caret}>
                ▸
              </span>
              VOICE
            </button>
            <span className={styles.talkMode}>
              <Segmented<TalkMode>
                label="Talk"
                hideLabel
                size="sm"
                value={talkMode}
                options={[
                  { value: 'open', label: 'OPEN' },
                  { value: 'ptt', label: 'PUSH' },
                  { value: 'latch', label: 'LATCH' },
                ]}
                onChange={setTalkMode}
              />
            </span>
            <LiveMeters bus={live?.bus ?? null} />
            <span className={styles.voiceSummary} title="The voice preset">
              {presetName ?? 'CUSTOM'}
            </span>
            <button
              type="button"
              className={styles.talk}
              data-talking={(on && micOpen && talking) || undefined}
              disabled={!on && !learning}
              onClick={learning ? learnOr('ptt', () => {}) : undefined}
              onPointerDown={() => !learning && talk(true)}
              onPointerUp={() => !learning && talk(false)}
              onPointerLeave={() => !learning && talkMode === 'ptt' && held && talk(false)}
              data-testid="live-talk"
            >
              {talkText}
              {talkMode !== 'open' && <kbd>SPACE</kbd>}
              {badge('ptt')}
            </button>
            <button type="button" className={styles.mute} data-on={muted || undefined} onClick={() => setMuted(!muted)} disabled={!on}>
              {muted ? 'MUTED' : 'MUTE'}
            </button>
            <div className={styles.flex} />
            <Button
              size="sm"
              variant={takeState === 'idle' ? 'secondary' : 'danger'}
              disabled={!on}
              onClick={() => void toggleTake()}
              title="Record a dry take (after a count-in) and open it in the Studio as the source · R"
              data-testid="live-take"
            >
              {takeState === 'count' ? 'COUNT-IN…' : takeState === 'rec' ? '■ TAKE → STUDIO' : '● TAKE'}
            </Button>
            <Button size="sm" variant={setT0 != null ? 'danger' : 'secondary'} disabled={!on} onClick={() => void recordSet()} data-testid="live-rec-set">
              {setT0 != null ? `■ STOP SET · ${clock((setNow - setT0) / 1000)}` : '● REC SET'}
            </Button>
          </div>
          {lastSet && (
            <div className={styles.setDone}>
              <span>
                SET · {clock(lastSet.durationS)} · {lastSet.filename}
              </span>
              <a className={common.button} data-variant="secondary" data-size="sm" href={lastSet.url} download={lastSet.filename}>
                SAVE WAV
              </a>
              <Button size="sm" onClick={() => void addSetToVault()}>
                ADD TO VAULT
              </Button>
            </div>
          )}
          {voiceIsOpen && (
            <div className={styles.voiceBody}>
              <div className={styles.voiceGroup}>
                <h3 className={styles.cardTitle}>
                  PRESETS <kbd>1–7</kbd>
                </h3>
                <div className={styles.presetPads}>
                  {presets.slice(0, 8).map((p: Preset, i) => (
                    <button
                      key={p.id}
                      type="button"
                      className={styles.pad}
                      data-active={p.id === presetId || undefined}
                      onClick={learnOr(`preset:${i}`, () => studio.applyPreset(p))}
                    >
                      <span className={styles.padNo}>{p.factory && i < 7 ? i + 1 : 'U'}</span>
                      {p.name}
                      {badge(`preset:${i}`)}
                    </button>
                  ))}
                </div>
              </div>
              <div className={styles.voiceGroup}>
                <h3 className={styles.cardTitle}>
                  FX
                  <div className={styles.quantize} title="Where the FX pads land">
                    <Segmented<Quantize | 'auto'>
                      label="Quantize"
                      hideLabel
                      size="sm"
                      value={quantize}
                      options={[
                        { value: 'auto', label: 'EACH', title: 'Each FX on its own grid (swell on the bar, stutter on 1/16)' },
                        { value: '1/16', label: '1/16' },
                        { value: 'beat', label: 'BEAT' },
                        { value: 'bar', label: 'BAR' },
                      ]}
                      onChange={setQuantize}
                    />
                  </div>
                </h3>
                <div className={styles.fxPads}>
                  {FX.map((f) => (
                    <button
                      key={f.name}
                      type="button"
                      className={styles.fxPad}
                      data-firing={firing[f.name] || undefined}
                      disabled={!on && !learning}
                      onClick={learnOr(`pad:${f.name}`, () => fire(f.name))}
                      data-testid={`live-fx-${f.name}`}
                    >
                      {f.label}
                      <kbd>{f.key.toUpperCase()}</kbd>
                      {badge(`pad:${f.name}`)}
                    </button>
                  ))}
                </div>
              </div>
              <div className={styles.voiceGroup}>
                <h3 className={styles.cardTitle}>MACROS</h3>
                <div className={styles.macros}>
                  {MACRO_IDS.map((id) => (
                    <div key={id} className={styles.macro}>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.01}
                        value={macros[id]}
                        onChange={(e) => studio.setMacro(id, Number(e.target.value))}
                        aria-label={MACRO_LABEL[id]}
                        disabled={learning}
                      />
                      <b>{Math.round(macros[id] * 100)}</b>
                      {learning ? (
                        <button type="button" className={styles.macroLearn} onClick={learnOr(`macro:${id}`, () => {})}>
                          {MACRO_LABEL[id]}
                          {badge(`macro:${id}`)}
                        </button>
                      ) : (
                        <span>{MACRO_LABEL[id]}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
              <div className={styles.voiceGroup}>
                <h3 className={styles.cardTitle}>MIC & MIDI</h3>
                {!on && <p className={styles.hint}>START the audio source for the pads, TAKE and REC SET.</p>}
                {on && source !== 'mic' && (
                  <button
                    type="button"
                    className={styles.toggle}
                    data-on={micOpen || undefined}
                    onClick={() => void (micOpen ? closeMic() : ensureMic())}
                    title="Talk over the track: opens the mic (clips then carry your masked voice too)"
                    data-testid="arm-mic"
                  >
                    {micOpen ? '● MIC ARMED' : 'ARM MIC'}
                  </button>
                )}
                <button
                  type="button"
                  className={styles.toggle}
                  data-on={learning || undefined}
                  disabled={!midi}
                  onClick={() => {
                    if (learning) midi?.cancelLearn()
                    setLearnTarget(null)
                    setLearning(!learning)
                  }}
                  title={
                    midi ? 'Click a pad, macro or push-to-talk, then move a knob or hit a pad on your controller' : 'No MIDI controller access'
                  }
                >
                  MIDI LEARN
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </Screen>
  )
}
