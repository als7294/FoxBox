import type { TdSettings, TdStatus } from '@shared/bridge'
import { useEffect, useRef, useState } from 'react'
import { NumberField, TextField } from '@/components/common/Fields'
import { Switch } from '@/components/rack/Switch'
import { agoText } from '@/components/updates/format'
import { bridge } from '@/env'
import { touchDesigner } from './feed'

const CONNECTED_MS = 5000 // a control from TouchDesigner this recent counts as connected

/** SETTINGS → TouchDesigner: on/off, where TouchDesigner runs, the two OSC ports, and whether it's talking back. */
export function TouchDesignerFields() {
  const td = bridge()?.touchdesigner
  const [conf, setConf] = useState<TdSettings | null>(null)
  const [status, setStatus] = useState<TdStatus | null>(null)
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!td) return
    void td.getSettings().then(setConf)
    const poll = () => void td.getStatus().then(setStatus, () => {})
    poll()
    const timer = setInterval(poll, 1000)
    return () => clearInterval(timer)
  }, [td])

  if (!td || !conf) return null
  const save = (patch: Partial<TdSettings>, delay = 0) => {
    setConf({ ...conf, ...patch })
    if (pending.current) clearTimeout(pending.current)
    pending.current = setTimeout(() => {
      void td.setSettings(patch).then((saved) => {
        setConf(saved)
        touchDesigner.applySettings(saved)
      })
    }, delay)
  }
  const heard = status?.lastIn && Date.now() - status.lastIn.at < CONNECTED_MS
  const line = !conf.enabled
    ? 'Off'
    : status?.error
      ? `Problem: ${status.error}`
      : heard
        ? `Connected · last from TouchDesigner: ${status!.lastIn!.address}`
        : status?.lastIn
          ? `Sending · TouchDesigner last talked ${agoText(status.lastIn.at, Date.now())}`
          : `Sending to ${conf.host}:${conf.outPort} · listening on :${conf.inPort} (nothing from TouchDesigner yet)`

  return (
    <>
      <Switch row label="Send to TouchDesigner" checked={conf.enabled} onChange={(v) => save({ enabled: v })} />
      <TextField label="TouchDesigner host" value={conf.host} mono hint="127.0.0.1 when it runs on this Mac"
        onChange={(v) => setConf({ ...conf, host: v })} onCommit={(v) => save({ host: v })} />
      <NumberField label="Out port (TD's OSC In)" value={conf.outPort} min={1024} max={65535} step={1}
        onChange={(v) => save({ outPort: Math.round(v) }, 600)} />
      <NumberField label="In port (TD's OSC Out)" value={conf.inPort} min={1024} max={65535} step={1}
        onChange={(v) => save({ inPort: Math.round(v) }, 600)} />
      <p role="status" aria-live="polite" data-connected={heard ? '' : undefined}>
        {line}
      </p>
    </>
  )
}
