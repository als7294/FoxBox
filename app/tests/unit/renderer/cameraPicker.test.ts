import { afterEach, describe, expect, it, vi } from 'vitest'
import { chooseCamera, currentCamera, listCameras, openCamera } from '@/components/camera/smartCameraBase'
import { darkRoom } from '@/components/camera/vision'

const stream = (id: string) => ({ id, getVideoTracks: () => [{ getSettings: () => ({ deviceId: id }) }], getTracks: () => [] }) as unknown as MediaStream

function devices(present: string[]) {
  const getUserMedia = vi.fn(async (c: MediaStreamConstraints) => {
    const want = ((c.video as MediaTrackConstraints).deviceId as { exact?: string } | undefined)?.exact
    if (want && !present.includes(want)) throw Object.assign(new Error('gone'), { name: 'OverconstrainedError' })
    return stream(want ?? present[0]!)
  })
  const enumerateDevices = vi.fn(async () => [
    ...present.map((id, i) => ({ kind: 'videoinput', deviceId: id, label: i ? '' : 'FaceTime HD Camera' })),
    { kind: 'audioinput', deviceId: 'mic', label: 'Mic' },
  ])
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia, enumerateDevices } })
  return getUserMedia
}

afterEach(() => vi.unstubAllGlobals())

describe("SETTINGS' camera picker", () => {
  it('lists the cameras (named, or numbered before they are allowed)', async () => {
    devices(['cam-a', 'cam-b'])
    expect(await listCameras()).toEqual([
      { id: 'cam-a', label: 'FaceTime HD Camera' },
      { id: 'cam-b', label: 'Camera 2' },
    ])
  })

  it("opens the picked camera, the default when it isn't there; a swap never falls back", async () => {
    const gum = devices(['cam-a', 'cam-b'])
    expect((await openCamera('cam-b')).id).toBe('cam-b')
    expect((await openCamera('gone')).id).toBe('cam-a') // a Continuity Camera out of reach: the default
    expect(gum).toHaveBeenLastCalledWith(expect.objectContaining({ video: expect.not.objectContaining({ deviceId: expect.anything() }) }))
    await expect(openCamera('gone', false)).rejects.toThrow('gone')
  })

  it('remembers the pick', async () => {
    const store: Record<string, string> = {}
    vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v), removeItem: (k: string) => void delete store[k] })
    expect(await chooseCamera('cam-b')).toBe(true) // no camera running: just remembered
    expect(store['foxbox-camera']).toBe('cam-b')
    expect(currentCamera()).toBe('cam-b')
    await chooseCamera(null)
    expect(store['foxbox-camera']).toBeUndefined()
  })
})

describe('too dark to track', () => {
  it('says so after a second under the line, and stops once well over it (no flicker)', () => {
    const s = { dark: false, since: -1 }
    expect(darkRoom(s, -1, 0)).toBe(false) // not measured yet
    expect(darkRoom(s, 0.08, 0)).toBe(false)
    expect(darkRoom(s, 0.08, 900)).toBe(false) // a passing shadow
    expect(darkRoom(s, 0.08, 1000)).toBe(true)
    expect(darkRoom(s, 0.14, 1100)).toBe(true) // between the lines: stays
    expect(darkRoom(s, 0.2, 1200)).toBe(false)
    expect(darkRoom(s, 0.14, 1300)).toBe(false)
    expect(darkRoom(s, 0.08, 1400)).toBe(false) // the second's clock starts again
  })
})
