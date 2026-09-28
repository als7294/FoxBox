// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary } from '../../../src/renderer/src/components/common/ErrorBoundary'

afterEach(cleanup)

let broken = true
function Flaky() {
  if (broken) throw new Error('latencyMs without a mic')
  return <p>stage ok</p>
}

describe('ErrorBoundary', () => {
  it('keeps a render error inside its panel and RESET mounts it again', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(
      <div>
        <p>rest of the app</p>
        <ErrorBoundary scope="STAGE" compact>
          <Flaky />
        </ErrorBoundary>
      </div>,
    )
    expect(screen.getByText('rest of the app')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('STAGE · SOMETHING BROKE')
    expect(screen.getByText('latencyMs without a mic')).toBeTruthy()
    broken = false
    fireEvent.click(screen.getByRole('button', { name: 'RESET' }))
    expect(screen.getByText('stage ok')).toBeTruthy()
    quiet.mockRestore()
  })
})
