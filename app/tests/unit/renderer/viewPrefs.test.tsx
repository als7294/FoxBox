// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { VoiceCore } from '../../../src/renderer/src/components/signal/VoiceCore'
import { useViewPrefs } from '../../../src/renderer/src/state/viewPrefs'

afterEach(cleanup)

describe('voice core panel', () => {
  it('closes with its × and remembers it; the SETTINGS switch brings it back', () => {
    useViewPrefs.getState().setShowVoiceCore(true)
    render(<VoiceCore />)
    fireEvent.click(screen.getByRole('button', { name: 'Hide voice core' }))
    expect(useViewPrefs.getState().showVoiceCore).toBe(false)
    expect(JSON.parse(window.localStorage.getItem('foxbox-view') ?? '{}')).toEqual({ showVoiceCore: false })
    useViewPrefs.getState().setShowVoiceCore(true)
    expect(JSON.parse(window.localStorage.getItem('foxbox-view') ?? '{}')).toEqual({ showVoiceCore: true })
  })
})
