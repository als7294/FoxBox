import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FOXBOX_INPUTS, parseIsf } from '@/visuals/engines/isf/loader'

const ISF = join(__dirname, '../../../src/renderer/src/visuals/engines/isf')

describe('ISF loader (SHADERS)', () => {
  it.each([['shaders', 15, 'generator'], ['filters', 10, 'filter']] as const)('loads every pack %s (inputs FoxBox fills, audio as images)', (dir, least, kind) => {
    const files = readdirSync(join(ISF, dir)).filter((f) => f.endsWith('.fs'))
    expect(files.length).toBeGreaterThanOrEqual(least)
    const known = new Set<string>([...FOXBOX_INPUTS.float, ...FOXBOX_INPUTS.color, ...FOXBOX_INPUTS.image, 'inputImage'])
    for (const file of files) {
      const s = parseIsf(readFileSync(join(ISF, dir, file), 'utf8'), file)
      expect(s.kind, file).toBe(kind)
      expect(s.error, file).toBeNull()
      expect(s.credit, file).toMatch(/FoxBox/)
      for (const input of s.inputs) expect(known.has(input.NAME), `${file}: ${input.NAME}`).toBe(true)
      expect(s.source).not.toMatch(/"audio(FFT)?"/) // the renderer library only knows images
      expect(s.source, file).not.toMatch(/IMG_(NORM_)?PIXEL\([^)]*\(/) // it splits the arguments on commas
    }
  })

  it('names user files safely and explains what is wrong with a bad one', () => {
    const ok = parseIsf('/*{"INPUTS":[{"NAME":"fft","TYPE":"audioFFT"}]}*/\nvoid main(){gl_FragColor=vec4(1.0);}', 'My Glow_2.fs')
    expect([ok.id, ok.label, ok.error, ok.inputs[0]?.TYPE]).toEqual(['my-glow-2', 'MY GLOW 2', null, 'image'])
    expect(parseIsf('void main(){}', 'x.fs').error).toMatch(/No ISF header/)
    expect(parseIsf('/*{ nope }*/ void main(){}', 'x.fs').error).toMatch(/isn't valid JSON/)
    expect(parseIsf('/*{"INPUTS":[{"NAME":"a b","TYPE":"float"}]}*/ void main(){}', 'x.fs').error).toMatch(/NAME/)
    expect(parseIsf('/*{"INPUTS":[{"NAME":"x","TYPE":"cube"}]}*/ void main(){}', 'x.fs').error).toMatch(/unsupported TYPE/)
    expect(parseIsf('/*{}*/ float f(){return 1.0;}', 'x.fs').error).toMatch(/main/)
  })
})
