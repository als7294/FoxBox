// REMIX (2.0, unstyled: the Claude Design handoff styles it; 1.5.5's STRINGS): play a song through your hands. The
// SongBlock, the CameraStage with REMIX's chips (StringsPreview), the BEAT FX sheet with the strings' knobs and AUDIO FX,
// and RECORD (a video, or the audio alone as a WAV take), OUTPUT and face hiding. Mounted from the first visit on: leaving
// pauses the song on the bar, and coming back finds it there.
import { useEffect } from 'react'
import { t } from '@/i18n'
import { FaceHidingToggle, OutputButton, RecordButton, TakeChip } from '@/components/stage/StageControls'
import { closeWheel, followShaka, openWheel, useWheelUi } from '@/components/wheel/WheelOverlay'
import { finishTake, startTake, useTakes } from '@/components/stage/takes'
import { setStemsGate } from '@/audio/live/songDeck'
import { isTextTarget } from '@/lib/shortcuts'
import { getClipAudio, useLiveDeck, useRemixDeck } from '@/state/liveDeck'
import { useSong, watchSongRestore } from '@/state/song'
import { toast } from '@/state/toasts'
import { useUi } from '@/state/ui'
import { startMeters } from './meters'
import { startRecording, stopRecording, useProdRec, watchOutput } from './prodActions'
import { useProd } from './prodStore'
import { SongBlock, togglePlay } from './SongBlock'
import { StringsPanel } from './StringsPanel'
import { StringsPreview } from './StringsPreview'
import { stemsGate } from './stems'
import s from '@/components/stage/stage.module.css'

/** R on REMIX: a video clip, or a WAV take of the track; again to stop and save. */
export function toggleRemixRecord(): void {
  if (useProdRec.getState().t0 != null) return void stopRecording()
  if (useTakes.getState().t0 != null) return void finishTake()
  if (useProd.getState().recordKind === 'video') return startRecording()
  const audio = getClipAudio()
  if (!audio) return void toast.warn(t('rec.playFirst.short', 'Play the track first'), { detail: t('rec.playFirst.take', 'A take records the playing track.') })
  startTake(audio.ctx, audio.node, ` - ${useSong.getState().song?.name ?? 'TEST BEAT'}`)
}

/** Space play/pause, R record and L the library wheel while REMIX shows (Space stays a button's own on buttons,
 *  sliders and tabs); while the wheel is open only L (and its Esc) act: the rest is the search's. */
export function useRemixKeys(active: boolean) {
  useEffect(() => {
    if (!active) return
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || isTextTarget(e.target) || useUi.getState().booting) return
      const wheel = useWheelUi.getState().open
      if (e.key === 'l' || e.key === 'L') (wheel ? closeWheel : openWheel)()
      else if (wheel) return
      else if (e.key === ' ') {
        if ((e.target as Element | null)?.closest?.('button, [role="slider"], [role="tab"], [role="switch"], select')) return
        togglePlay()
      } else if (e.key === 'r' || e.key === 'R') toggleRemixRecord()
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active])
}

export function RemixPage() {
  const active = useUi((u) => u.mode === 'remix')
  const kind = useProd((p) => p.recordKind)
  const clipT0 = useProdRec((r) => r.t0)
  const takeT0 = useTakes((t) => t.t0)
  const takes = useTakes((t) => t.recent)
  useEffect(() => watchOutput(), [])
  useEffect(() => startMeters(), [])
  useEffect(() => watchSongRestore(), [])
  useEffect(() => setStemsGate(stemsGate), []) // the Demucs notice before the first split's download
  useRemixDeck()
  // The shaka opens the library wheel while REMIX shows; leaving REMIX closes it
  useEffect(() => {
    if (!active) return
    const stop = followShaka()
    return () => {
      stop()
      closeWheel()
    }
  }, [active])
  // Leaving REMIX pauses the song on the bar (a running RECORD stops in the mode switch)
  useEffect(() => {
    if (active) return
    const deck = useLiveDeck.getState().deck
    if (!deck?.isPlaying) return
    deck.stop()
    deck.seek(deck.positionS())
  }, [active])
  useRemixKeys(active)
  return (
    <div data-testid="remix">
      <h1 className="sr-only">REMIX</h1>
      <SongBlock />
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 320px', gap: 12, height: '60vh' }}>
        <StringsPreview />
        <StringsPanel />
      </div>
      <div className={s.row}>
        <select
          aria-label="Record"
          value={kind}
          disabled={clipT0 != null || takeT0 != null}
          onChange={(e) => useProd.getState().setRecordKind(e.target.value as 'video' | 'wav')}
        >
          <option value="video">Video</option>
          <option value="wav">Audio (WAV)</option>
        </select>
        <RecordButton t0={clipT0 ?? takeT0} onClick={toggleRemixRecord} />
        {takes.map((t) => (
          <TakeChip key={t.path} take={t} />
        ))}
        <OutputButton />
        <FaceHidingToggle />
      </div>
    </div>
  )
}
