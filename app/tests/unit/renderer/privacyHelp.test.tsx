// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PrivacyHelp } from '@/components/common/PrivacyHelp'

describe('PrivacyHelp', () => {
  it('names the pane and the tccutil reset for the real bundle id', () => {
    render(<PrivacyHelp kind="camera" />)
    expect(screen.getByText(/Camera access is off for FoxBox\. Allow it in System Settings → Privacy & Security → Camera\./)).toBeInTheDocument()
    expect(screen.getByText('Not listed there?')).toBeInTheDocument()
    expect(screen.getByText('tccutil reset Camera com.smittytech.foxbox')).toBeInTheDocument()
  })

  it('says Microphone for the mic', () => {
    render(<PrivacyHelp kind="mic" />)
    expect(screen.getByText('tccutil reset Microphone com.smittytech.foxbox')).toBeInTheDocument()
  })
})
