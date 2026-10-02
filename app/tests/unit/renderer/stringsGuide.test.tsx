// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openStringsGuide, StringsGuide, useStringsGuide } from '@/components/whatsnew/StringsGuide'
import { WhatsNew } from '@/components/whatsnew/WhatsNew'
import { useUi } from '@/state/ui'

describe("WHAT'S NEW 1.5.5's STRINGS guide", () => {
  afterEach(() => {
    cleanup()
    useStringsGuide.setState({ replay: false })
    localStorage.clear()
  })

  it('steps with ← → and the dots, and ends on OPEN STRINGS with the rest of the release', () => {
    const onOpen = vi.fn()
    render(<StringsGuide also={[{ version: '1.5.5', title: null, body: 'TouchDesigner is paused for now (WIP).' }]} onOpen={onOpen} onLater={() => {}} />)
    const guide = screen.getByTestId('strings-guide')
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('REMIX THE DROP WITH YOUR HANDS')
    fireEvent.keyDown(guide, { key: 'ArrowRight' })
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('LOAD A TRACK')
    fireEvent.keyDown(guide, { key: 'ArrowLeft' })
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('REMIX THE DROP')
    fireEvent.click(screen.getByRole('button', { name: /^Step 6 of 6/ }))
    expect(screen.getByText('TouchDesigner is paused for now (WIP).')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('guide-open'))
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it("GUIDE on STRINGS' cheat sheet plays it again, even after it was seen; Esc closes it", () => {
    localStorage.setItem('foxbox-whatsnew-seen', '1.5.5')
    useUi.setState({ booting: false })
    render(<WhatsNew current="1.5.5" />)
    expect(screen.queryByTestId('strings-guide')).toBeNull()
    act(() => openStringsGuide())
    expect(screen.getByTestId('strings-guide')).toBeInTheDocument()
    fireEvent.keyDown(screen.getByTestId('whats-new'), { key: 'Escape' })
    expect(screen.queryByTestId('strings-guide')).toBeNull()
  })
})
