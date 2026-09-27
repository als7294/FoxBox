import type { SetupInfo } from '@shared/bridge'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import type { ModelInfo } from '@/api/types'
import { Button } from '@/components/common/Button'
import { CreditLink } from '@/components/common/CreditLink'
import { FoxMark } from '@/components/common/FoxMark'
import { bridge, isMockMode } from '@/env'
import { formatBytes } from '@/lib/format'
import { tildePath } from '@/lib/paths'
import { connectEngineStatus, engineView } from '@/state/engine'
import { ComponentList, DiskMeter } from './ComponentList'
import { InstallProgress, type LogLine } from './InstallProgress'
import {
  diskNeeds,
  failureKind,
  formatPair,
  initialSelection,
  installPlan,
  overallProgress,
  remainingBytes,
  rowView,
  type PlanItem,
  type RowState,
  type RowView,
  type Selection,
} from './plan'
import { SetupError, SetupReady } from './SetupOutcomes'
import { SetupWelcome } from './SetupWelcome'
import { useSetupData, useSetupInstall } from './useSetupInstall'
import styles from './setup.module.css'

type Step = 'welcome' | 'components' | 'installing' | 'ready'
const STEPS: { id: Step; label: string }[] = [
  { id: 'welcome', label: '01 Welcome' },
  { id: 'components', label: '02 Components' },
  { id: 'installing', label: '03 Install' },
  { id: 'ready', label: '04 Ready' },
]

// Per-viewer conveniences only (the engine holds the real state): optional picks, and "setup was started before".
const PICKS_KEY = 'foxbox.setup.picks'
const STARTED_KEY = 'foxbox.setup.started'
function readStore(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}
function writeStore(key: string, value: string | null): void {
  try {
    if (value == null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // private window or blocked storage: the defaults apply next time
  }
}
function savedPicks(): Selection {
  try {
    const raw = JSON.parse(readStore(PICKS_KEY) ?? '{}') as unknown
    return raw && typeof raw === 'object' ? (raw as Selection) : {}
  } catch {
    return {}
  }
}

const clock = () => new Date().toLocaleTimeString([], { hour12: false })

function describe(v: RowView): string {
  switch (v.state) {
    case 'queued':
      return 'queued'
    case 'downloading':
      return `downloading (${formatPair(v.bytesDone, v.bytesTotal)})`
    case 'verifying':
      return 'verifying'
    case 'done':
      return 'installed'
    case 'cancelled':
      return 'stopped'
    case 'failed':
      return `failed: ${v.error?.message ?? 'unknown error'}`
  }
}

/** The first-run Setup window (`index.html?window=setup`), 900×620. */
export function SetupWindow() {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } }))
  return (
    <QueryClientProvider client={client}>
      <SetupFlow />
    </QueryClientProvider>
  )
}

function useSetupInfo(): SetupInfo | null {
  const [info, setInfo] = useState<SetupInfo | null>(null)
  useEffect(() => {
    const b = bridge()
    if (!b || isMockMode()) return
    void b.setup
      .info()
      .then((i) => i && setInfo(i))
      .catch(() => {})
  }, [])
  return info
}

function SetupFlow() {
  useEffect(() => connectEngineStatus(), [])
  useEffect(() => {
    document.title = 'FoxBox Setup'
  }, [])
  const [step, setStep] = useState<Step>('welcome')
  const [picks, setPicks] = useState<Selection>(savedPicks)
  const [plan, setPlan] = useState<PlanItem[] | null>(null)
  const [cancelled, setCancelled] = useState(false)
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  const [log, setLog] = useState<LogLine[]>([])
  const info = useSetupInfo()
  const data = useSetupData(step === 'installing')
  const { models, health, status } = data
  const selection = models ? initialSelection(models, picks) : {}
  const install = useSetupInstall(plan, models)
  // When each job was first seen moving bytes: speed and ETA only show after about a second of transfer.
  const moving = useRef<Record<string, number>>({})
  const nowMs = Date.now()
  const views = plan
    ? plan.map((item) => {
        const job = install.jobs[item.id]
        let transferMs = 0
        if (job?.state === 'running' && (job.bytes_done ?? 0) > 0) transferMs = nowMs - (moving.current[job.id] ??= nowMs)
        return rowView(item, models?.find((m) => m.id === item.id), job, install.lost[item.id], transferMs)
      })
    : []
  const overall = plan ? overallProgress(plan, views) : null
  const view = engineView(status)
  const mock = isMockMode()
  const b = bridge()

  // Start the downloads once the plan is set (required first, then the picks).
  const started = useRef(false)
  useEffect(() => {
    if (step !== 'installing' || !plan || started.current) return
    started.current = true
    void install.start()
  }, [step, plan, install])

  // The log: every row state change, with the time.
  const seen = useRef<Record<string, RowState>>({})
  useEffect(() => {
    if (!plan) return
    const lines: LogLine[] = []
    plan.forEach((item, i) => {
      const v = views[i]
      if (!v || seen.current[item.id] === v.state) return
      seen.current[item.id] = v.state
      lines.push({ at: clock(), text: `${item.name}: ${describe(v)}` })
    })
    if (lines.length) setLog((cur) => [...cur, ...lines].slice(-200))
  })

  // Everything installed: on to READY.
  const allDone = Boolean(overall?.allDone)
  useEffect(() => {
    if (step !== 'installing' || !allDone) return
    const t = window.setTimeout(() => setStep('ready'), 700)
    return () => window.clearTimeout(t)
  }, [step, allDone])

  const toggle = (id: string, on: boolean) => {
    const next = { ...picks, [id]: on }
    setPicks(next)
    writeStore(PICKS_KEY, JSON.stringify(next))
  }

  const beginInstall = () => {
    if (!models) return
    writeStore(STARTED_KEY, '1')
    setPlan(installPlan(models, selection))
    setCancelled(false)
    setStep('installing')
  }

  const openStudio = async () => {
    setOpening(true)
    setOpenError(null)
    try {
      if (b && !mock) {
        const result = await b.setup.complete()
        if (!result.ok) {
          setOpenError(result.error ?? 'Setup could not finish.')
          return
        }
      } else if (b) {
        // Electron dev with mocks: main skips the engine check.
        const result = await b.setup.complete()
        if (!result.ok) setOpenError(result.error ?? 'Setup could not finish.')
      } else {
        writeStore(STARTED_KEY, null)
        writeStore(PICKS_KEY, null)
        window.location.assign(`${window.location.pathname}?mock=1`)
        return
      }
      writeStore(STARTED_KEY, null)
      writeStore(PICKS_KEY, null)
    } catch (err) {
      setOpenError((err as Error).message)
    } finally {
      setOpening(false)
    }
  }

  const stopInstall = async () => {
    await install.cancelAll()
    setCancelled(true)
  }
  const resume = () => {
    setCancelled(false)
    if (plan) void install.start(plan.filter((_, i) => views[i]?.state !== 'done').map((p) => p.id))
  }

  // ------------------------------------------------------------------ what the install screen reports
  let problem = null
  if (step === 'installing' && plan && overall) {
    const failedRequired = plan.map((item, i) => ({ item, v: views[i]! })).filter(({ item, v }) => item.required && v.state === 'failed')
    if (view === 'offline') {
      problem = (
        <SetupError
          kind="engine"
          message={status.lastError ?? 'The engine stopped.'}
          hint={info?.translocated ? 'Move FoxBox to Applications, then open it again.' : 'Downloads resume once it runs again.'}
        >
          {b && (
            <Button variant="danger" onClick={() => void b.restartEngine()}>
              Restart engine
            </Button>
          )}
        </SetupError>
      )
    } else if (cancelled) {
      problem = (
        <SetupError kind="cancelled" message="What is downloaded stays on this Mac." hint="Setup picks up where it stopped next time you open FoxBox.">
          <Button variant="primary" onClick={resume}>
            Resume now
          </Button>
          {b && (
            <Button variant="ghost" onClick={() => window.close()}>
              Quit
            </Button>
          )}
        </SetupError>
      )
    } else if (failedRequired.length) {
      const first = failedRequired[0]!.v.error
      const kind = failureKind(first)
      const retry = () => void install.start(failedRequired.map(({ item }) => item.id))
      if (kind === 'disk') {
        // What's still to come (not done yet), plus the reserve once, against what's free now.
        const pending = plan
          .filter((_, i) => views[i]?.state !== 'done')
          .map((item) => models?.find((m) => m.id === item.id))
          .filter((m): m is ModelInfo => Boolean(m))
        const left = diskNeeds(pending, Object.fromEntries(pending.map((m) => [m.id, true])), health?.disk_free_bytes ?? null)
        problem = (
          <SetupError
            kind="disk"
            message={left.freeBytes != null ? `Needs ${formatBytes(left.neededBytes)}, ${formatBytes(left.freeBytes)} free.` : (first?.message ?? 'The disk is full.')}
            hint="Free up space (empty the Trash, move old exports), then retry."
          >
            <Button variant="danger" onClick={retry}>
              Retry
            </Button>
          </SetupError>
        )
      } else {
        problem = (
          <SetupError
            kind={kind}
            message={first?.message ?? 'The download failed.'}
            hint={
              kind === 'network'
                ? 'Check the connection. Retry resumes where it stopped.'
                : kind === 'checksum'
                  ? 'Retry downloads the damaged file again.'
                  : (first?.hint ?? undefined)
            }
          >
            <Button variant="danger" onClick={retry}>
              Retry
            </Button>
          </SetupError>
        )
      }
    } else if (install.error) {
      problem = (
        <SetupError kind="other" message={install.error}>
          <Button variant="danger" onClick={() => void install.start()}>
            Retry
          </Button>
        </SetupError>
      )
    }
  }

  const rowsNow = plan?.map((item, i) => ({ item, v: views[i] })) ?? []
  const downloading = rowsNow.find(({ v }) => v?.state === 'downloading' || v?.state === 'verifying')
  const next = rowsNow.find(({ v }) => v?.state === 'queued')
  const current = downloading
    ? downloading.v!.state === 'verifying'
      ? `Verifying ${downloading.item.name}`
      : `Downloading ${downloading.v!.currentItem ?? downloading.item.name}`
    : next && !cancelled
      ? `Next: ${next.item.name}`
      : null
  const resumeHint = readStore(STARTED_KEY) === '1' || Boolean(models?.some((m) => !m.installed && remainingBytes(m) < m.size_bytes))
  const rawModelsDir = info?.modelsDir ?? (health ? `${health.data_dir}/models` : null)
  const modelsDir = rawModelsDir ? tildePath(rawModelsDir, info?.home) : null
  const needs = diskNeeds(models ?? [], selection, health?.disk_free_bytes ?? null)
  const engineNote =
    view === 'offline'
      ? `The engine is not running: ${status.lastError ?? 'unknown error'}`
      : view === 'starting' || view === 'restarting'
        ? (status.detail ?? 'Starting the engine…')
        : null
  const stepIndex = STEPS.findIndex((s) => s.id === step)

  return (
    <div className={styles.window} data-step={step}>
      <header className={styles.top}>
        <FoxMark size={24} className={styles.mark} />
        <span className={styles.brand}>
          FOXBOX <span className={styles.brandSub}>· SETUP</span>
        </span>
        <ol className={styles.steps} aria-label="Setup steps">
          {STEPS.map((s, i) => (
            <li key={s.id} aria-current={s.id === step ? 'step' : undefined} data-done={i < stepIndex || undefined}>
              {s.label}
            </li>
          ))}
        </ol>
      </header>

      <main className={styles.body}>
        {step === 'welcome' && (
          <SetupWelcome resume={resumeHint} health={health} engineNote={engineNote} translocated={Boolean(info?.translocated)} onStart={() => setStep('components')} />
        )}

        {step === 'components' && (
          <>
            <div>
              <div className={styles.kicker}>02 / Components</div>
              <h1 className={styles.title}>What to install</h1>
            </div>
            {models ? (
              <>
                <ComponentList
                  models={models}
                  selection={selection}
                  jobs={install.jobs}
                  engineLabel={info?.bundled ? 'Bundled' : mock ? 'Mock' : 'Linked'}
                  onToggle={toggle}
                />
                <DiskMeter needs={needs} />
              </>
            ) : (
              <p className={styles.note}>{engineNote ?? (data.modelsError ? `Could not list the models: ${data.modelsError.message}` : 'Asking the engine what to install…')}</p>
            )}
            <div className={styles.actions}>
              <Button variant="ghost" onClick={() => setStep('welcome')}>
                Back
              </Button>
              {needs.short && (
                <Button variant="secondary" onClick={data.refetch}>
                  Check again
                </Button>
              )}
              <Button variant="primary" size="lg" disabled={!models || needs.short} onClick={beginInstall}>
                Install{needs.downloadBytes ? ` · ${formatBytes(needs.downloadBytes)}` : ''}
              </Button>
            </div>
          </>
        )}

        {step === 'installing' && plan && overall && (
          <InstallProgress
            plan={plan}
            views={views}
            overall={overall}
            current={current}
            problem={problem}
            log={log}
            cancelled={cancelled}
            opening={opening}
            openError={openError}
            onCancel={() => void stopInstall()}
            onOpenNow={() => void openStudio()}
            onContinue={() => setStep('ready')}
            onRetryItem={(id) => {
              setCancelled(false)
              void install.start([id])
            }}
            {...(b ? { onOpenLogs: () => void b.openLogs() } : {})}
          />
        )}

        {step === 'ready' && plan && <SetupReady plan={plan} views={views} opening={opening} error={openError} onOpen={() => void openStudio()} />}
      </main>

      <footer className={styles.foot}>
        <span className={styles.footNote} title={modelsDir ?? undefined}>
          {step === 'components' && modelsDir ? `Models live in ${modelsDir}` : `Engine · ${view}`}
        </span>
        <CreditLink />
      </footer>
    </div>
  )
}
