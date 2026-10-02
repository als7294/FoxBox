// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TdSetup } from '@/components/prod/TdSetup'
import { useProd } from '@/components/prod/prodStore'
import { toast } from '@/state/toasts'
import { useTdSession } from '@/touchdesigner/session'

describe('PROD first-run setup', () => {
  afterEach(cleanup)

  it('counts the done steps, grows the first one not done, and goes live once all four pass', () => {
    const success = vi.spyOn(toast, 'success')
    useTdSession.setState({
      state: 'starting',
      version: '2025.3',
      steps: { installed: 'done', patch: 'doing', activated: 'todo', connected: 'todo' },
    })
    const { container } = render(<TdSetup />)
    expect(screen.getByText('1')).toBeInTheDocument() // 1 / 4
    expect(screen.getByText('TouchDesigner 2025.3 found.')).toBeInTheDocument()
    const current = container.querySelector('[aria-current="step"]')
    expect(current).toHaveTextContent('FOXBOX PATCH BUILT')
    expect(current).toHaveTextContent('… WORKING')
    expect(screen.getByRole('button', { name: 'SETTING UP…' })).toBeDisabled()
    expect(useProd.getState().setupDone).toBe(false)

    act(() => useTdSession.setState({ state: 'live', steps: { installed: 'done', patch: 'done', activated: 'done', connected: 'done' } }))
    expect(screen.getByText('4')).toBeInTheDocument()
    expect(useProd.getState().setupDone).toBe(true)
    expect(success).toHaveBeenCalledOnce()
    expect(success).toHaveBeenCalledWith('TOUCHDESIGNER CONNECTED · GOING LIVE')
  })
})
