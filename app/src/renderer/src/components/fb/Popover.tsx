// The popover (2.0 design §5): the dock's width, risen from just above it, tinted by the selection (SAUCE's sound;
// REMIX orange, red while a Beat FX is held). It keeps the last content while it fades out.
import { useRef, type ReactNode } from 'react'
import { beatFxNow } from '@/audio/live/beatFx'
import type { SoundId } from '@/audio/play/instrument'
import { usePlay } from '@/components/play/playStore'
import { useUi } from '@/state/ui'
import { useFb, type Pop } from './fbStore'
import s from './pop.module.css'

const TINT: Record<SoundId, string> = {
  '808': '242,112,31',
  reese: '139,92,246',
  growl: '229,64,43',
  wobble: '34,195,181',
  pluck: '245,177,61',
  lead: '236,72,153',
  keys: '79,142,247',
}

export function PopHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className={s.head}>
      <div className={s.headText}>
        <span className={s.title}>{title}</span>
        {sub && <span className={s.sub}>{sub}</span>}
      </div>
      {children && <div className={s.headRight}>{children}</div>}
    </div>
  )
}

export const KeyChip = ({ children }: { children: ReactNode }) => <span className={s.keyChip}>{children}</span>

export function Section({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div className={s.sectionRow}>
      <span className={s.section}>{label}</span>
      {children}
    </div>
  )
}

export function Popover({ content }: { content: (pop: Pop) => ReactNode }) {
  const pop = useFb((f) => f.pop)
  const mode = useUi((u) => u.mode)
  const sound = usePlay((p) => p.sound)
  const last = useRef<Pop | null>(null)
  if (pop) last.current = pop
  const shown = pop ?? last.current
  const tint = mode === 'play' ? TINT[sound] : beatFxNow().fx ? '229,64,43' : '242,112,31'
  return (
    <section
      className={s.pop}
      data-open={pop ? true : undefined}
      aria-hidden={!pop}
      aria-label={shown ?? undefined}
      style={{ ['--tint' as string]: tint }}
    >
      <button type="button" className={s.close} aria-label="Close" onClick={() => useFb.setState({ pop: null })}>
        ×
      </button>
      {shown && content(shown)}
    </section>
  )
}
