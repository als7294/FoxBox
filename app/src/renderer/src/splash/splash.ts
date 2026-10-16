// The boot splash's page (2.1, main/splash.ts): plain DOM, no React, so it paints at once. It draws what main sends:
// the main window's real milestones, the update check at boot, a stall or crash (Retry / Quit). Tips from the GUIDE
// rotate under it. Big text only.
import './splash.css'
import { BOOT_STEPS, NO_REPORT, type BootStep, type SplashAct, type SplashView } from '@shared/splash'
import { clockText, rateText, transferText } from '@/components/updates/format'
import { bridge } from '@/env'
import { t, useLang } from '@/i18n'
import bgUrl from '@/assets/launch/strings-splash.webp' // the user's Strings key art: the fox holding the strings, dark on the right
import markUrl from '../../../../design/brand/icons/bare/A/fox-strings.svg?url' // S3's Strings fox head (the app icons' A)
import wordmarkUrl from '../../../../design/brand/foxbox-strings-wordmark.svg?url'

const TIP_MS = 3500

const stepText = (step: BootStep | 'ready'): string =>
  ({
    camera: t('boot.step.camera', 'Opening the camera'),
    tracking: t('boot.step.tracking', 'Loading hand tracking'),
    strings: t('boot.step.strings', 'Stringing the strings'),
    sound: t('boot.step.sound', 'Starting the sound'),
    update: t('boot.step.update', 'Checking for updates'),
    ready: t('boot.step.ready', 'Ready'),
  })[step]

const failedText = (step: NonNullable<SplashView['failed']>['step']): string =>
  ({
    window: t('boot.failed.window', 'FoxBox’s window didn’t start.'),
    camera: t('boot.failed.camera', 'The camera didn’t open.'),
    tracking: t('boot.failed.tracking', 'Hand tracking didn’t load.'),
    strings: t('boot.failed.strings', 'The strings didn’t load.'),
    sound: t('boot.failed.sound', 'The sound didn’t start.'),
  })[step]

/** The GUIDE's shortcuts and moves, one at a time. */
const tips = (): string[] => [
  t('boot.tip.guide', 'G opens the GUIDE any time.'),
  t('boot.tip.style', 'S cycles PLUCK · FLOW · LOOP.'),
  t('boot.tip.frame', 'F frames, P changes the effect.'),
  t('boot.tip.library', 'L or 🤙 opens your library.'),
  t('boot.tip.play', 'Change how you play in Settings.'),
  t('boot.tip.loop', 'LOOP: shape a melody by hand.'),
  t('boot.tip.hands', 'Hands up. No controller, no excuses.'),
]

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent: HTMLElement): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  e.className = cls
  parent.appendChild(e)
  return e
}
const img = (cls: string, src: string, parent: HTMLElement) => Object.assign(el('img', cls, parent), { src, alt: '', draggable: false })

const lang = useLang.getState().lang
document.documentElement.lang = lang === 'pt' ? 'pt-BR' : lang
const root = el('div', 'splash', document.body)
root.setAttribute('role', 'status')
root.setAttribute('aria-label', t('launch.aria', 'FoxBox is starting'))
img('bg', bgUrl, root)
el('div', 'scrim', root)
img('mark', markUrl, root)
const wordmark = img('wordmark', wordmarkUrl, root)
wordmark.alt = 'FoxBox Strings'
const status = el('div', 'status', root)
status.setAttribute('aria-live', 'polite')
const lines = [el('span', '', status), el('span', '', status)]
let line = 0
/** The step's line: the next one slides in as the last slides out; the sweep stops once ready. */
function say(text: string, done = false): void {
  const cur = lines[line]!
  if (cur.textContent !== text) {
    line = 1 - line
    const next = lines[line]!
    next.textContent = text
    delete next.dataset.was
    next.dataset.on = ''
    delete cur.dataset.on
    cur.dataset.was = ''
  }
  const on = lines[line]!
  if (done) on.dataset.done = ''
  else delete on.dataset.done
}
const bar = el('div', 'bar', el('div', 'track', root))
const detail = el('div', 'detail', root)
const problem = el('div', 'problem', root)
const tip = el('div', 'tip', root)
const tipHead = el('div', 'tipHead', tip)
// a small spark, in the accent
tipHead.innerHTML =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0l1.8 6.2L16 8l-6.2 1.8L8 16l-1.8-6.2L0 8l6.2-1.8z"/></svg>'
el('span', '', tipHead).textContent = t('boot.tip.label', 'TIP')
const tipText = el('div', 'tipText', tip)
const layers = [el('span', '', tipText), el('span', '', tipText)]

function showProblem(head: string, line: string, buttons: [string, SplashAct, boolean][]): void {
  problem.replaceChildren()
  el('b', '', problem).textContent = head
  if (line) el('span', '', problem).textContent = line
  const row = el('div', 'btns', problem)
  for (const [label, act, primary] of buttons) {
    const b = el('button', '', row)
    b.type = 'button'
    b.textContent = label
    if (primary) b.dataset.primary = ''
    b.onclick = () => bridge()?.boot.act(act)
  }
  row.querySelector('button')?.focus()
}

let shownProblem = ''
function render(v: SplashView): void {
  const u = v.update
  const failed = !v.ready && (v.failed ? `stall:${v.failed.step}` : u.phase === 'failed' ? `update:${u.error ?? ''}` : '')
  status.hidden = bar.parentElement!.hidden = detail.hidden = tip.hidden = Boolean(failed)
  problem.hidden = !failed
  if (failed && failed !== shownProblem) {
    if (v.failed) {
      showProblem(t('boot.failed.title', 'FoxBox didn’t start'), [failedText(v.failed.step), v.failed.detail].filter(Boolean).join(' '), [
        [t('update.retry', 'Retry'), 'retry', true],
        [t('boot.quit', 'Quit'), 'quit', false],
      ])
    } else {
      const go = u.current ? t('launch.update.continueWith', 'Continue with {version}', { version: u.current }) : t('launch.update.continue', 'Continue')
      showProblem(t('launch.update.failed', 'Couldn’t update FoxBox'), u.error ?? '', [
        [go, 'continue', true],
        [t('boot.quit', 'Quit'), 'quit', false],
      ])
    }
  }
  shownProblem = failed || ''
  if (failed) return

  let frac: number
  if (v.ready) {
    say(stepText('ready'), true)
    detail.textContent = ''
    frac = 1
    root.dataset.ready = ''
  } else if (u.phase === 'required') {
    // UPDATE REQUIRED: it downloads, verifies and restarts into the new version
    const d = u.download
    frac = u.step === 'downloading' ? (d && d.bytes_total > 0 ? d.bytes_done / d.bytes_total : 0) : 1
    say(
      u.step === 'installing'
        ? t('launch.update.restarting', 'Restarting…')
        : u.step === 'verifying'
          ? t('launch.update.verifying', 'Checking the update…')
          : t('launch.update.progress', 'Updating FoxBox · {pct} %', { pct: Math.round(Math.min(1, frac) * 100) }),
    )
    detail.textContent =
      u.step === 'downloading' && d
        ? [
            transferText(d.bytes_done, d.bytes_total),
            ...(d.rate_bps ? [rateText(d.rate_bps)] : []),
            ...(d.eta_s != null ? [t('update.left', '{time} left', { time: clockText(d.eta_s) })] : []),
          ].join(' · ')
        : `${u.current} → ${u.version ?? ''}`
  } else {
    const done = (s: BootStep) => (s === 'update' ? u.phase === 'clear' : v.report[s])
    const next = BOOT_STEPS.find((s) => !done(s))
    say(stepText(next ?? 'ready'), !next)
    detail.textContent = ''
    frac = Math.max(0.04, BOOT_STEPS.filter(done).length / BOOT_STEPS.length)
  }
  bar.style.transform = `scaleX(${Math.max(0, Math.min(1, frac))})`
}

/** A tip with its keys (a lone G, F, P, L or S) as keycaps. */
function fillTip(into: HTMLElement, text: string): void {
  into.replaceChildren(
    ...text.split(/\b([GFPLS])\b/).map((part, i) => {
      if (i % 2 === 0) return document.createTextNode(part)
      const k = document.createElement('kbd')
      k.textContent = part
      return k
    }),
  )
}

// the tips: a new one every few seconds, cross-faded (at once with reduced motion)
const all = tips()
let at = Math.floor(Math.random() * all.length)
let layer = 0
function showTip(): void {
  layer = 1 - layer
  fillTip(layers[layer]!, all[at] ?? '')
  layers[layer]!.dataset.on = ''
  delete layers[1 - layer]!.dataset.on
}
showTip()
setInterval(() => {
  at = (at + 1) % all.length
  showTip()
}, TIP_MS)

render({ report: NO_REPORT, update: { phase: 'clear', current: __APP_VERSION__, version: null, sizeBytes: null, step: null, download: null, attempt: 0, error: null }, ready: false, failed: null })
bridge()?.boot.onView(render)
