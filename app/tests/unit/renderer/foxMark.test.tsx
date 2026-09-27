// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FoxMark } from '../../../src/renderer/src/components/common/FoxMark'

const svg = readFileSync(resolve(__dirname, '../../../design/brand/foxbox-mark.svg'), 'utf8')
const attrs = (source: string, name: string) => [...source.matchAll(new RegExp(`\\s${name}="([^"]+)"`, 'g'))].map((m) => m[1])

describe('FoxMark', () => {
  it('draws exactly the brand file (design/brand/foxbox-mark.svg), so a new mark is one copy away', () => {
    const { container } = render(<FoxMark />)
    const drawn = container.innerHTML
    expect(attrs(drawn, 'd')).toEqual(attrs(svg, 'd'))
    expect(attrs(drawn, 'stroke-width')).toEqual(attrs(svg, 'stroke-width'))
    expect(attrs(drawn, 'viewBox')).toEqual(attrs(svg, 'viewBox'))
  })

  it('gives every instance its own mask', () => {
    const { container } = render(
      <>
        <FoxMark />
        <FoxMark title="FoxBox" />
      </>,
    )
    const ids = [...container.querySelectorAll('mask')].map((m) => m.id)
    expect(new Set(ids).size).toBe(2)
    expect(container.querySelector('svg[role="img"]')).toHaveAttribute('aria-label', 'FoxBox')
  })
})
