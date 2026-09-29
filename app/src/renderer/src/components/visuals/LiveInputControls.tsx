import { useEffect, useRef, useState } from 'react'
import { listAudioInputs, LiveInputError, openLiveInput, type AudioInputDevice, type LiveInput, type LiveInputSpec } from '@/audio/live/input'
import { Button } from '@/components/common/Button'
import { Segmented } from '@/components/rack/Segmented'
import live from '@/components/live/live.module.css'
import styles from './visuals.module.css'

type InputKind = 'system' | 'interface'
const PAIRS: [number, number][] = [
  [1, 2],
  [3, 4],
  [5, 6],
  [7, 8],
]

/**
 * AUDIO SOURCE → LIVE INPUT: the DJ's own sound driving the visuals (S2's audio/live/input.ts): the Mac's system
 * audio (Rekordbox's output), or an audio interface's channel pair (the mixer's record out). Listen-only: nothing is
 * played back. The open input goes up to the page (the stage reads it); leaving LIVE INPUT closes it.
 */
export function LiveInputControls({ onInput }: { onInput(input: LiveInput | null): void }) {
  const [kind, setKind] = useState<InputKind>('system')
  const [devices, setDevices] = useState<AudioInputDevice[]>([])
  const [deviceId, setDeviceId] = useState('')
  const [pair, setPair] = useState(0)
  const [input, setInput] = useState<LiveInput | null>(null)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [latency, setLatency] = useState<number | null>(null)
  const current = useRef<LiveInput | null>(null)
  const onInputRef = useRef(onInput)
  onInputRef.current = onInput

  const refresh = async () => {
    try {
      const list = (await listAudioInputs()).filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
      setDevices(list)
    } catch {
      // no device list: the interface picker stays empty
    }
  }
  useEffect(() => {
    void refresh()
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh)
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refresh)
  }, [])

  const close = async () => {
    const i = current.current
    current.current = null
    setInput(null)
    setLatency(null)
    onInputRef.current(null)
    await i?.close().catch(() => {})
  }
  useEffect(() => () => void close(), []) // eslint-disable-line react-hooks/exhaustive-deps

  const open = async () => {
    setError(null)
    setOpening(true)
    const spec: LiveInputSpec =
      kind === 'system' ? { kind: 'system' } : { kind: 'interface', deviceId: deviceId || devices[0]?.deviceId || 'default', channels: PAIRS[pair] }
    try {
      await close()
      const i = await openLiveInput(spec)
      current.current = i
      setInput(i)
      onInputRef.current(i)
      void refresh() // labels arrive once an input is allowed
    } catch (e) {
      setError(e instanceof LiveInputError ? e.message : (e as Error).message)
    } finally {
      setOpening(false)
    }
  }

  useEffect(() => {
    if (!input) return
    const tick = () => setLatency(input.latencyMs())
    tick()
    const t = window.setInterval(tick, 1000)
    return () => window.clearInterval(t)
  }, [input])

  // A new choice while listening applies at once (reopens).
  const change = (fn: () => void) => {
    fn()
    if (input) void close()
  }

  return (
    <div className={live.clipBody} data-testid="visuals-live-input">
      <Segmented<InputKind>
        label="Live input"
        hideLabel
        size="sm"
        value={kind}
        options={[
          { value: 'system', label: 'SYSTEM AUDIO', title: "What the Mac is playing (Rekordbox's output)" },
          { value: 'interface', label: 'AUDIO INTERFACE', title: "A channel pair from your mixer's interface" },
        ]}
        onChange={(k) => change(() => setKind(k))}
      />
      {kind === 'interface' && (
        <>
          <label className={live.field}>
            <span>DEVICE</span>
            <select value={deviceId} onChange={(e) => change(() => setDeviceId(e.target.value))}>
              {!devices.length && <option value="">NO INPUTS</option>}
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <label className={live.field}>
            <span>CHANNELS</span>
            <select value={pair} onChange={(e) => change(() => setPair(Number(e.target.value)))}>
              {PAIRS.map(([l, r], i) => (
                <option key={l} value={i}>
                  {l} – {r}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {error && (
        <p className={styles.inlineError} role="alert">
          {error}
        </p>
      )}
      {input ? (
        <div className={styles.inputOn}>
          <span className={styles.inputLabel} title={input.label}>
            ● {input.label}
          </span>
          <span className={styles.kicker}>{latency != null ? `${Math.round(latency)} MS` : ''}</span>
          <Button size="sm" variant="danger" onClick={() => void close()} data-testid="visuals-input-stop">
            ■ STOP
          </Button>
        </div>
      ) : (
        <Button
          variant="primary"
          disabled={opening || (kind === 'interface' && !devices.length)}
          onClick={() => void open()}
          title="Listen to it (nothing is played back)"
          data-testid="visuals-input-start"
        >
          {opening ? 'OPENING…' : '▶ START INPUT'}
        </Button>
      )}
    </div>
  )
}
