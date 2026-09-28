import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
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
import { click } from '@/audio/recorder'
import { Button } from '@/components/common/Button'
import common from '@/components/common/common.module.css'
import { Screen, ScreenHeader } from '@/components/layout/Screen'
import { LiveCamera } from '@/components/live/LiveCamera'
import { LiveMeters } from '@/components/live/LiveMeters'
import { LiveSongStrip } from '@/components/live/LiveSongStrip'
import styles from '@/components/live/live.module.css'
import { orderPresets } from '@/components/rack/PresetStrip'
import { Segmented } from '@/components/rack/Segmented'
import { addTake, setTakeShortcut } from '@/components/source/takes'
import { bridge } from '@/env'
import { useSong } from '@/state/song'
import { studio, useStudio } from '@/state/studio'
import { toast } from '@/state/toasts'
import { useUi } from '@/state/ui'
import { LiveVisuals } from '@/visuals/live/LiveVisuals'

type Status = 'off' | 'starting' | 'on' | 'error'
type TalkMode = 'open' | 'ptt' | 'latch'
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

/**
 * LIVE (1.3): the voice mask in real time, laid out to perform. The mic goes through S2's live rack (audio/live) with
 * the Studio's preset and macros: preset pads, BPM-quantised FX pads (S2's triggers, on the session grid), four
 * macros, push-to-talk, MIDI learn for all of them (S2's MidiMap), recording the set (S2's SetRecorder), input and
 * output devices and the round-trip latency. The song deck strip plays the Studio's song under the voice. The stage
 * in the middle is S4's (visuals and the output window); camera clips reuse the camera pipeline.
 */
export function LiveScreen() {
  const [status, setStatus] = useState<Status>('off')
  const [error, setError] = useState<string | null>(null)
  const [live, setLive] = useState<LiveEngine | null>(null)
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([])
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([])
  const [inputId, setInputId] = useState('')
  const [outputId, setOutputId] = useState('')
  const [latencyMode, setLatencyMode] = useState<LatencyMode>('low')
  const [latency, setLatency] = useState<number | null>(null)
  const [quantize, setQuantize] = useState<Quantize | 'auto'>('auto')
  const [firing, setFiring] = useState<Partial<Record<LiveTrigger, boolean>>>({})
  const [talkMode, setTalkMode] = useState<TalkMode>('open')
  const [held, setHeld] = useState(false) // push-to-talk held
  const [latched, setLatched] = useState(false)
  const [muted, setMuted] = useState(false)
  const talking = !muted && (talkMode === 'open' || (talkMode === 'ptt' ? held : latched))
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
  const [songLevel, setSongLevel] = useState(0)
  const [songDuck, setSongDuck] = useState(true)

  const liveRef = useRef<LiveEngine | null>(null)
  liveRef.current = live
  const talkModeRef = useRef(talkMode)
  talkModeRef.current = talkMode

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

  useEffect(() => {
    if (!live || !song) return setDeck(null)
    const d = new SongDeck(live)
    let alive = true
    d.load(song).then(
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
  }, [live, song?.id])
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
  /** The talk control (button, Space, a MIDI note or pedal): hold in PUSH TO TALK, toggle in LATCH. */
  const talk = useCallback((down: boolean) => {
    const mode = talkModeRef.current
    if (mode === 'ptt') setHeld(down)
    else if (mode === 'latch' && down) setLatched((v) => !v)
  }, [])

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
      if (b && !(await b.askMicAccess())) throw new Error('Microphone access is off for FoxBox.')
      const engine = await LiveEngine.create({ deviceId: inputId || undefined, latency: latencyMode, bpm: useStudio.getState().bpm })
      if (outputId) await (engine.ctx as SinkContext).setSinkId?.(outputId)
      setLive(engine)
      setStatus('on')
      void refreshDevices() // labels arrive once the mic is allowed
    } catch (e) {
      setStatus('error')
      setError((e as Error).message)
    }
  }
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
      if ((e.target as HTMLElement | null)?.closest('input, select, textarea')) return
      if (e.key === ' ') {
        e.preventDefault()
        if (!e.repeat) talk(true)
        return
      }
      const fx = FX.find((f) => f.key === e.key.toLowerCase())
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
  const onLatency = async (mode: LatencyMode) => {
    setLatencyMode(mode)
    await live?.setLatencyMode(mode)
  }

  return (
    <Screen className={styles.screen} data-testid="live-screen" data-learning={learning || undefined}>
      <ScreenHeader code="02" kicker="PERFORMANCE" title="LIVE">
        <div className={styles.headBar}>
          <span className={styles.status} data-status={status} role="status">
            {status === 'on' ? '● LIVE' : status === 'starting' ? 'STARTING…' : status === 'error' ? 'NO INPUT' : 'OFF'}
          </span>
          <span className={styles.readout} title="Round trip: output, input and the pitch shifter">
            <b>{latency != null ? Math.round(latency) : '—'}</b> MS
          </span>
          <span className={styles.readout}>
            <b>{Math.round(bpm)}</b> BPM
          </span>
          <span className={styles.readout}>
            <b>{key}</b> KEY
          </span>
          <LiveMeters bus={live?.bus ?? null} />
          <div className={styles.quantize} title="Where the FX pads land">
            <Segmented<Quantize | 'auto'>
              label="Quantize"
              hideLabel
              size="sm"
              value={quantize}
              options={[
                { value: 'auto', label: 'AUTO', title: 'Each FX on its own grid (swell on the bar, stutter on 1/16)' },
                { value: '1/16', label: '1/16' },
                { value: 'beat', label: 'BEAT' },
                { value: 'bar', label: 'BAR' },
              ]}
              onChange={setQuantize}
            />
          </div>
          {!headphones && (
            <span className={styles.warn} title="On speakers the mic hears the mask and feeds back: use headphones">
              ⚠ HEADPHONES
            </span>
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
          <Button
            variant={takeState === 'idle' ? 'secondary' : 'danger'}
            disabled={!on}
            onClick={() => void toggleTake()}
            title="Record a dry take (after a count-in) and open it in the Studio as the source · R"
            data-testid="live-take"
          >
            {takeState === 'count' ? 'COUNT-IN…' : takeState === 'rec' ? '■ TAKE → STUDIO' : '● TAKE'}
          </Button>
          <Button
            variant={setT0 != null ? 'danger' : 'secondary'}
            disabled={!on}
            onClick={() => void recordSet()}
            data-testid="live-rec-set"
          >
            {setT0 != null ? `■ STOP SET · ${clock((setNow - setT0) / 1000)}` : '● REC SET'}
          </Button>
          {on ? (
            <Button variant="danger" onClick={() => void stop()} data-testid="live-stop">
              ■ STOP
            </Button>
          ) : (
            <Button variant="primary" size="lg" onClick={() => void start()} disabled={status === 'starting'} data-testid="live-start">
              ● GO LIVE
            </Button>
          )}
        </div>
      </ScreenHeader>
      {error && <p className={styles.error}>{error}</p>}
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

      <div className={styles.grid}>
        <aside className={styles.side}>
          <section className={styles.card} aria-label="Setup">
            <h2 className={styles.cardTitle}>SETUP</h2>
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
            <div className={styles.field}>
              <span>LATENCY</span>
              <Segmented<LatencyMode>
                label="Latency"
                hideLabel
                size="sm"
                value={latencyMode}
                options={[
                  { value: 'low', label: 'LOW', title: 'Performing (a little grainier on low voices)' },
                  { value: 'balanced', label: 'SMOOTH', title: 'Smoother pitch shifting, a few ms more' },
                ]}
                onChange={(m) => void onLatency(m)}
              />
            </div>
            <p className={styles.hint}>Use headphones: the mask comes back through the output while you talk.</p>
          </section>
          <LiveCamera live={live} />
        </aside>

        <div className={styles.center}>
          <LiveSongStrip deck={deck} level={songLevel} duck={songDuck} onLevel={setSongLevel} onDuck={setSongDuck} />
          {/* The stage: S4's visuals (LiveVisuals) and the output window go here. */}
          <div className={styles.stage}>
            <div className={styles.stageSlot}>
              <LiveVisuals bus={live?.bus ?? null} deck={deck} bpm={bpm} />
            </div>
          </div>
          <div className={styles.talkRow}>
            <div className={styles.talkModes}>
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
                onChange={(m) => {
                  setHeld(false)
                  setLatched(false)
                  setTalkMode(m)
                }}
              />
              <button type="button" className={styles.mute} data-on={muted || undefined} onClick={() => setMuted(!muted)} disabled={!on}>
                {muted ? 'MUTED' : 'MUTE'}
              </button>
            </div>
            <button
              type="button"
              className={styles.talk}
              data-talking={(on && talking) || undefined}
              disabled={!on && !learning}
              onClick={learning ? learnOr('ptt', () => {}) : undefined}
              onPointerDown={() => !learning && talk(true)}
              onPointerUp={() => !learning && talk(false)}
              onPointerLeave={() => !learning && talkMode === 'ptt' && held && talk(false)}
              data-testid="live-talk"
            >
              {muted
                ? 'MUTED'
                : talkMode === 'open'
                  ? on
                    ? 'MIC OPEN'
                    : 'MIC'
                  : talking
                    ? 'TALKING'
                    : talkMode === 'ptt'
                      ? 'HOLD TO TALK'
                      : 'TAP TO TALK'}
              {talkMode !== 'open' && <kbd>SPACE</kbd>}
              {badge('ptt')}
            </button>
          </div>
        </div>

        <section className={styles.perform} aria-label="Performance">
          <div className={styles.card}>
            <h2 className={styles.cardTitle}>
              PRESETS <kbd>1–7</kbd>
            </h2>
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
          <div className={styles.card}>
            <h2 className={styles.cardTitle}>
              FX <kbd>A S D F G</kbd>
            </h2>
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
          <div className={styles.card}>
            <h2 className={styles.cardTitle}>MACROS</h2>
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
        </section>
      </div>
    </Screen>
  )
}
