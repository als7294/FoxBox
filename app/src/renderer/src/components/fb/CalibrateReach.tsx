// Calibrate reach (2.0.1 one-handed): Settings → Playing's and the one-handed GUIDE's.
import { useEffect, useState } from 'react'
import { captureReach } from '@/components/camera/smartCamera'
import s from './settings.module.css'

/** Calibrate reach (2.0.1): the playing hand's highest, then lowest comfortable note, each after a 3 s count so the one
 *  hand never has to press anything (S1's captureReach); a step with no hand seen asks again. */
export function CalibrateReach({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState<'high' | 'low' | 'done'>('high')
  const [count, setCount] = useState(3)
  const [missed, setMissed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (step === 'done') return
    setMissed(false)
    let n = 3
    setCount(n)
    const t = window.setInterval(() => {
      setCount(--n)
      if (n > 0) return
      window.clearInterval(t)
      if (!captureReach(step)) return setMissed(true)
      setStep(step === 'high' ? 'low' : 'done')
    }, 1000)
    return () => window.clearInterval(t)
  }, [step, attempt])
  return (
    <div className={s.calib} role="status" aria-live="polite">
      {step === 'done' ? (
        <>
          <b>Reach set</b>
          <span className={s.note}>Your notes now span the heights you can reach comfortably.</span>
          <button type="button" className={s.btn} data-primary onClick={onDone}>
            Done
          </button>
        </>
      ) : (
        <>
          <b>{step === 'high' ? 'Hold your playing hand at the highest note you can reach comfortably' : 'Now at your lowest'}</b>
          {missed ? (
            <span className={s.btns} style={{ alignItems: 'center' }}>
              <span className={s.note}>No hand seen. Keep it where the camera sees it.</span>
              <button type="button" className={s.btn} onClick={() => setAttempt((a) => a + 1)}>
                Try again
              </button>
            </span>
          ) : (
            <span className={s.calibCount}>{count}</span>
          )}
          <button type="button" className={s.btn} onClick={onDone}>
            Cancel
          </button>
        </>
      )}
    </div>
  )
}
