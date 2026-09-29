import { Button } from '@/components/common/Button'
import { Segmented } from '@/components/rack/Segmented'
import { camera, useCamera } from './cameraStore'
import styles from './twoFaces.module.css'

/** A second person in frame (FacePicker): ask inline, once. Both faces stay masked until the answer. */
export function TwoFacesPrompt() {
  const ask = useCamera((c) => c.twoFaces && c.settings.people === 1 && !c.justMe)
  if (!ask) return null
  return (
    <div className={styles.ask} role="status" aria-live="polite" data-testid="two-faces">
      <p>
        <b>▲ 2 PEOPLE IN FRAME?</b> Both faces are masked for now.
      </p>
      <div className={styles.row}>
        <Button size="sm" onClick={() => camera.setPeople(2)}>
          MASK BOTH
        </Button>
        <Button size="sm" onClick={() => camera.setPeople(1)}>
          JUST ME
        </Button>
      </div>
    </div>
  )
}

/** PEOPLE: the main face only (the default), or two. */
export function PeopleControl() {
  const people = useCamera((c) => c.settings.people)
  return (
    <Segmented<'1' | '2'>
      label="People"
      hideLabel
      size="sm"
      value={people === 2 ? '2' : '1'}
      options={[
        { value: '1', label: '1 PERSON', title: 'Mask the main face only' },
        { value: '2', label: '2 PEOPLE', title: 'Mask two faces' },
      ]}
      onChange={(v) => camera.setPeople(v === '2' ? 2 : 1)}
    />
  )
}
