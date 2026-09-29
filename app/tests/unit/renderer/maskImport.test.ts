import { describe, expect, it } from 'vitest'
import { maskFileProblem, maskName } from '@/components/camera/maskImport'

describe('mask import checks', () => {
  it('SVG, PNG or WebP (by type or extension), under the caps', () => {
    expect(maskFileProblem({ name: 'fox.svg', type: 'image/svg+xml', size: 1000 })).toBeNull()
    expect(maskFileProblem({ name: 'fox.webp', type: '', size: 1000 })).toBeNull()
    expect(maskFileProblem({ name: 'fox.gif', type: 'image/gif', size: 1000 })).toMatch(/SVG, PNG or WebP/)
    expect(maskFileProblem({ name: 'big.svg', type: 'image/svg+xml', size: 3 * 1024 * 1024 })).toMatch(/over 2 MB/)
    expect(maskFileProblem({ name: 'big.png', type: 'image/png', size: 3 * 1024 * 1024 })).toBeNull()
    expect(maskFileProblem({ name: 'huge.png', type: 'image/png', size: 17 * 1024 * 1024 })).toMatch(/over 16 MB/)
  })
  it('the name is the file name', () => {
    expect(maskName('My Wolf.v2.svg')).toBe('My Wolf.v2')
    expect(maskName('.png')).toBe('MASK')
  })
})
