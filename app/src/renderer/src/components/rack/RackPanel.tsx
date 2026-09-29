import { useEffect, useMemo, useRef } from 'react'
import type { MacroId, ModuleSpec, ParamValue, Preset, RackDescriptor, Voice } from '@/api/types'
import { MACRO_IDS } from '@/api/types'
import { macroControlled, macroTargetsView } from '@/lib/macros'
import { resetMacro, selectPreset } from '@/state/rackActions'
import { scheduleRender } from '@/state/renderController'
import { studio, useStudio } from '@/state/studio'
import { useUi } from '@/state/ui'
import { animate } from '@/visuals/motion'
import { Knob } from './Knob'
import { MacroKnob } from './MacroKnob'
import { ModuleCard } from './ModuleCard'
import { PresetStrip } from './PresetStrip'
import { SavePresetForm } from './SavePresetForm'
import styles from './rack.module.css'

const DRAWER_ID = 'rack-drawer'

function isActive(m: ModuleSpec, enabled: Map<string, boolean>): boolean {
  return m.available !== false && (enabled.get(m.id) ?? false)
}

/** RACK panel: OPEN RACK on top, then the preset strip (+ SAVE) and the four macro knobs with their map rings. */
export function RackPanel({ rack, presets }: { rack: RackDescriptor; presets: readonly Preset[] }) {
  const macros = useStudio((s) => s.macros)
  const macroMap = useStudio((s) => s.macroMap)
  const chain = useStudio((s) => s.chain)
  const presetId = useStudio((s) => s.presetId)
  const dirty = useStudio((s) => s.presetDirty)
  const open = useStudio((s) => s.rackOpen)
  const preset = presets.find((p) => p.id === presetId)
  const enabled = useMemo(() => new Map((chain.modules ?? []).map((m) => [m.id, m.enabled])), [chain])
  const active = rack.modules.filter((m) => isActive(m, enabled)).length
  const save = () => useUi.getState().setSavePresetOpen(true)
  const saving = useUi((s) => s.savePresetOpen)
  return (
    <section className={styles.rack} aria-label="Rack" data-reveal="4">
      <button
        type="button"
        className={styles.openRack}
        aria-label="Open rack"
        aria-expanded={open}
        aria-controls={DRAWER_ID}
        onClick={() => studio.setRackOpen(true)}
      >
        <span className={styles.leds} aria-hidden="true">
          {rack.modules.slice(0, 10).map((m) => (
            <span key={m.id} data-on={isActive(m, enabled) || undefined} />
          ))}
        </span>
        <span className={styles.openLabel}>OPEN RACK</span>
        <span className={styles.openMeta}>
          {rack.modules.length + 1} MODULES · {active} ACTIVE
        </span>
        <span className={styles.flex} />
        <span className={styles.openArrow} aria-hidden="true">
          ↑
        </span>
      </button>
      <div className={styles.rackHead}>
        <div className={styles.rackTitle}>
          <span className={styles.panelTitle}>PRESETS</span>
          <button type="button" className={styles.saveBtn} aria-label="Save preset, Command S" aria-keyshortcuts="Meta+S" onClick={save}>
            + SAVE
          </button>
        </div>
        {saving ? (
          <SavePresetForm presets={presets} onClose={() => useUi.getState().setSavePresetOpen(false)} />
        ) : (
          <PresetStrip presets={presets} activeId={presetId} dirty={dirty} onSelect={selectPreset} onSave={save} />
        )}
      </div>
      <div className={styles.macros}>
        {MACRO_IDS.map((id: MacroId) => {
          const spec = rack.macros.find((m) => m.id === id) ?? { id, label: id.toUpperCase(), description: '' }
          return (
            <MacroKnob
              key={id}
              spec={spec}
              value={macros[id] ?? 0.5}
              presetValue={preset?.macros?.[id] ?? 0.5}
              targets={macroTargetsView(id, macroMap, macros, rack.modules)}
              onChange={(v) => studio.setMacro(id, v)}
              onCommit={() => scheduleRender()}
              onReset={(v) => resetMacro(id, v)}
            />
          )
        })}
      </div>
    </section>
  )
}

/** Closes the drawer with the design's wipe-down, then hands focus back to OPEN RACK. */
export function closeRack(): void {
  const el = document.getElementById(DRAWER_ID)
  const done = () => {
    studio.setRackOpen(false)
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[aria-controls="${DRAWER_ID}"]`)?.focus({ preventScroll: true }))
  }
  const a = animate(el, [{ clipPath: 'inset(0 0 0 0)' }, { clipPath: 'inset(100% 0 0 0)' }], {
    duration: 300,
    easing: 'cubic-bezier(.7,0,.8,.3)',
    fill: 'forwards',
  })
  if (a) a.onfinish = done
  else done()
}

/** The full rack: one generic ModuleCard per module from GET /api/rack (CSS columns), plus the STACK voices. */
export function RackDrawer({ rack, voices }: { rack: RackDescriptor; voices: readonly Voice[] }) {
  const chain = useStudio((s) => s.chain)
  const stack = useStudio((s) => s.stack)
  const macroMap = useStudio((s) => s.macroMap)
  const presetName = useStudio((s) => s.presetName)
  const dirty = useStudio((s) => s.presetDirty)
  const resolved = useStudio((s) => s.render?.resolved_chain)
  const macros = useStudio((s) => s.macros)
  const controlled = useMemo(() => macroControlled(macroMap), [macroMap])
  // module → param → value the macros put there right now (moves while a macro knob turns).
  const live = useMemo(() => {
    const out = new Map<string, Map<string, number>>()
    for (const id of MACRO_IDS) {
      for (const t of macroTargetsView(id, macroMap, macros, rack.modules)) {
        const m = out.get(t.target.module) ?? new Map<string, number>()
        m.set(t.target.param, t.value)
        out.set(t.target.module, m)
      }
    }
    return out
  }, [macroMap, macros, rack.modules])
  const ref = useRef<HTMLDivElement>(null)
  const commit = () => scheduleRender()

  useEffect(() => {
    const el = ref.current
    animate(el, [{ clipPath: 'inset(100% 0 0 0)', opacity: 0.4 }, { clipPath: 'inset(0 0 0 0)', opacity: 1 }], {
      duration: 460,
      easing: 'cubic-bezier(.2,.8,.2,1)',
    })
    el?.querySelectorAll('[data-mod]').forEach((m, i) =>
      animate(m, [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], {
        duration: 320,
        delay: 120 + i * 28,
        fill: 'backwards',
        easing: 'cubic-bezier(.2,.8,.2,1)',
      }),
    )
    el?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })
  }, [])

  const perModule = (m: ModuleSpec) => {
    const map = new Map<string, MacroId>()
    for (const [key, macro] of controlled) {
      const [mod, param] = key.split('.')
      if (mod === m.id && param) map.set(param, macro)
    }
    return map
  }

  return (
    <div ref={ref} id={DRAWER_ID} role="region" aria-label="Rack modules" className={styles.drawer}>
      <div className={styles.drawerHead}>
        <span className={styles.drawerTitle}>RACK</span>
        <span className={styles.drawerMeta}>
          {rack.modules.length + 1} MODULES · {presetName ?? 'CUSTOM'}
          {dirty ? ' *' : ''}
        </span>
        <span className={styles.flex} />
        <button type="button" className={styles.drawerClose} aria-label="Close rack" onClick={closeRack}>
          CLOSE ↓
        </button>
      </div>
      <div className={styles.drawerBody}>
        <div className={styles.drawerColumns}>
          {rack.modules.map((m, i) => {
            const state = (chain.modules ?? []).find((s) => s.id === m.id)
            const resolvedParams = resolved?.modules?.find((s) => s.id === m.id)?.params as Record<string, ParamValue> | undefined
            return (
              <ModuleCard
                key={m.id}
                index={i}
                spec={m}
                state={state}
                controlled={perModule(m)}
                resolved={resolvedParams}
                live={live.get(m.id)}
                defaultOpen={i === 1 || i === 3}
                onToggle={(on) => studio.setModuleEnabled(m.id, on)}
                onParam={(paramId, value) => studio.setParam(m.id, paramId, value)}
                onCommit={commit}
              />
            )
          })}
          <section className={styles.module} data-mod="stack" data-open data-enabled aria-labelledby="mod-stack">
            <header className={styles.moduleHead}>
              <span className={styles.moduleN} aria-hidden="true">
                {String(rack.modules.length + 1).padStart(2, '0')}
              </span>
              <h3 className={styles.moduleTitle} id="mod-stack">
                STACK
              </h3>
            </header>
            <div className={styles.moduleBody}>
              <p className={styles.moduleDesc}>Extra TTS voices on the same script: the robotic collage.</p>
              {stack.length === 0 && <p className={styles.muted}>This preset has no stack voices.</p>}
              {stack.map((v, i) => (
                <div key={i} className={styles.stackRow}>
                  <div className={styles.param}>
                    <div className={styles.paramHead}>
                      <span className={styles.paramLabel}>VOICE {i + 1}</span>
                    </div>
                    <select
                      className={styles.paramSelect}
                      aria-label={`Stack voice ${i + 1}`}
                      value={v.voice_id ?? ''}
                      onChange={(e) => {
                        studio.setStackVoice(i, { voice_id: e.target.value || null })
                        commit()
                      }}
                    >
                      <option value="">DETUNED COPY</option>
                      {voices.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name.toUpperCase()}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className={styles.stackKnobs}>
                    <Knob label="PITCH" value={v.pitch_st ?? 0} min={-24} max={24} step={0.5} unit="st" defaultValue={0}
                      onChange={(x) => studio.setStackVoice(i, { pitch_st: x })} onCommit={commit} />
                    <Knob label="PAN" value={v.pan ?? 0} min={-1} max={1} defaultValue={0}
                      format={(x) => (Math.abs(x) < 0.01 ? 'C' : `${x < 0 ? 'L' : 'R'}${Math.round(Math.abs(x) * 100)}`)}
                      onChange={(x) => studio.setStackVoice(i, { pan: x })} onCommit={commit} />
                    <Knob label="GAIN" value={v.gain_db ?? -12} min={-60} max={6} unit="dB" defaultValue={-12}
                      onChange={(x) => studio.setStackVoice(i, { gain_db: x })} onCommit={commit} />
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
