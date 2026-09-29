// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import type { DragEvent } from 'react'
import { expect, it, vi } from 'vitest'
import { useSongFile } from '../../../src/renderer/src/components/song/SongStrip'
import { songs } from '../../../src/renderer/src/state/song'

it('LS8: a song dropped while the track plays waits, then loads on stop', () => {
  const importFile = vi.spyOn(songs, 'importFile').mockResolvedValue()
  let playing = true
  const { result } = renderHook(() => useSongFile({ open: false, hold: () => playing }))
  const file = new File(['x'], 'next.wav', { type: 'audio/wav' })
  const drop = { preventDefault() {}, dataTransfer: { files: [file] } } as unknown as DragEvent
  act(() => result.current.dropProps.onDrop(drop))
  expect(importFile).not.toHaveBeenCalled()
  expect(result.current.queued?.name).toBe('next.wav')
  act(() => result.current.flush()) // still playing: nothing
  expect(importFile).not.toHaveBeenCalled()
  playing = false
  act(() => result.current.flush())
  expect(importFile).toHaveBeenCalledWith(file, expect.objectContaining({ open: false }))
  expect(result.current.queued).toBeNull()
})
