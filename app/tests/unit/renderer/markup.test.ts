import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyEdit,
  decorate,
  deleteToken,
  insertBeat,
  insertPause,
  isRefusal,
  parse,
  segmentsOf,
  summarize,
  summarizeShort,
  toggleEcho,
  type Edit,
  type EditResult,
} from '../../../src/renderer/src/lib/markup'

interface Case {
  script: string
  segments: { text: string; flags: Record<string, unknown> }[]
}
const cases = (JSON.parse(readFileSync(resolve(__dirname, '../../../../fixtures/markup_cases.json'), 'utf8')) as { cases: Case[] }).cases

describe('script markup (shared cases with S1)', () => {
  it.each(cases.map((c) => [c.script, c] as const))('%s', (_script, c) => {
    const got = segmentsOf(c.script)
    expect(got.map((s) => s.text)).toEqual(c.segments.map((s) => s.text))
    expect(got.map((s) => s.flags)).toEqual(c.segments.map((s) => s.flags))
  })
})

/** [text, beat_break, throw, pause_after_s, pause_after_beats, line_break] */
type Seg = [string, 0 | 1, 0 | 1, number, number, 0 | 1]
/** [script, segments, warnings] or [script, the engine's error code] */
type EngineCase = [string, Seg[], string[]] | [string, string]

// The engine's own parse (fvwks_voice.markup.parse at S1 8408f8c) over the edge cases where the old
// highlighter disagreed with it, and more. Regenerate with the engine if its grammar changes.
// prettier-ignore
const ENGINE: EngineCase[] = [
  ["WE ARE GUY FVWKS | EXPECT *US*", [["WE ARE GUY FVWKS", 1, 0, 0, 0, 0], ["EXPECT *US*", 0, 1, 0, 0, 0]], []],
  ["ONE [500ms] TWO", [["ONE", 0, 0, 0.5, 0, 0], ["TWO", 0, 0, 0, 0, 0]], []],
  ["ONE [1/2b] TWO", [["ONE", 0, 0, 0, 0.5, 0], ["TWO", 0, 0, 0, 0, 0]], []],
  ["ONE [2 beats] TWO", [["ONE", 0, 0, 0, 2, 0], ["TWO", 0, 0, 0, 0, 0]], []],
  ["ONE [0.5s] TWO", [["ONE", 0, 0, 0.5, 0, 0], ["TWO", 0, 0, 0, 0, 0]], []],
  ["ONE [.5] TWO", [["ONE", 0, 0, 0.5, 0, 0], ["TWO", 0, 0, 0, 0, 0]], []],
  ["ONE [2B] TWO", [["ONE", 0, 0, 0, 2, 0], ["TWO", 0, 0, 0, 0, 0]], []],
  ["*EXPECT | US*", [["*EXPECT", 1, 1, 0, 0, 0], ["US*", 0, 1, 0, 0, 0]], []],
  ["*WE [0.5] ARE*", [["*WE", 0, 1, 0.5, 0, 0], ["ARE*", 0, 1, 0, 0, 0]], []],
  ["WE ARE LEGION\nEXPECT US", [["WE ARE LEGION", 0, 0, 0, 0, 1], ["EXPECT US", 0, 0, 0, 0, 0]], []],
  ["A \\| B \\*C\\*", [["A \\| B \\*C\\*", 0, 0, 0, 0, 0]], []],
  ["ONE | ... | TWO", [["ONE", 1, 0, 0, 0, 0], ["TWO", 0, 0, 0, 0, 0]], []],
  ["HI [LAUGHS] THERE", [["HI [LAUGHS] THERE", 0, 0, 0, 0, 0]], ["Ignored unknown tag '[LAUGHS]'."]],
  ["EXPECT *US", [["EXPECT *US", 0, 0, 0, 0, 0]], ["Ignored an unmatched '*'."]],
  ["[1b] WE ARE", [["WE ARE", 0, 0, 0, 0, 0]], ["Ignored a pause before the first words; use ARRANGE's first-word beat for pre-roll."]],
  ["ONE [1b] [1b] TWO", [["ONE", 0, 0, 0, 2, 0], ["TWO", 0, 0, 0, 0, 0]], []],
  ["ÉCOUTE | ÇA *VA*", [["ÉCOUTE", 1, 0, 0, 0, 0], ["ÇA *VA*", 0, 1, 0, 0, 0]], []],
  ["WE ARE 🔥 | GO", [["WE ARE 🔥", 1, 0, 0, 0, 0], ["GO", 0, 0, 0, 0, 0]], []],
  ["EXPECT **US**", [["EXPECT **US**", 0, 0, 0, 0, 0]], []],
  ["*FV*WKS IS HERE", [["*FV*WKS IS HERE", 0, 1, 0, 0, 0]], []],
  ["ONE [31] TWO", "pause_too_long"],
  ["", [], []],
  ["   ", [], []],
  ["|", [], []],
  ["| HELLO", [["HELLO", 0, 0, 0, 0, 0]], []],
  ["HELLO |", [["HELLO", 1, 0, 0, 0, 0]], []],
  ["[0.5]", [], ["Ignored a pause before the first words; use ARRANGE's first-word beat for pre-roll."]],
  ["[0.5] HELLO", [["HELLO", 0, 0, 0, 0, 0]], ["Ignored a pause before the first words; use ARRANGE's first-word beat for pre-roll."]],
  ["HELLO [0.5]", [["HELLO", 0, 0, 0.5, 0, 0]], []],
  ["A | | B", [["A", 1, 0, 0, 0, 0], ["B", 0, 0, 0, 0, 0]], []],
  ["A [1] [2b] B", [["A", 0, 0, 1, 2, 0], ["B", 0, 0, 0, 0, 0]], []],
  ["A [1] | [2b] B", [["A", 1, 0, 1, 2, 0], ["B", 0, 0, 0, 0, 0]], []],
  ["*A* *B*", [["*A* *B*", 0, 1, 0, 0, 0]], []],
  ["*A**B*", [["*A**B*", 0, 1, 0, 0, 0]], []],
  ["**A**", [["**A**", 0, 0, 0, 0, 0]], []],
  ["*A*B*C*", [["*A*B*C*", 0, 1, 0, 0, 0]], []],
  ["*HELLO*!!", [["*HELLO*!!", 0, 1, 0, 0, 0]], []],
  ["*!!* HELLO", [["*!!* HELLO", 0, 1, 0, 0, 0]], []],
  ["HELLO *,* WORLD", [["HELLO *,* WORLD", 0, 0, 0, 0, 0]], []],
  ["*DON'T* STOP", [["*DON'T* STOP", 0, 1, 0, 0, 0]], []],
  ["*DON'*T STOP", [["*DON'*T STOP", 0, 1, 0, 0, 0]], []],
  ["F*V*WKS", [["F*V*WKS", 0, 1, 0, 0, 0]], []],
  ["FV*WKS*", [["FV*WKS*", 0, 1, 0, 0, 0]], []],
  ["WE *ARE* GUY *FVWKS*", [["WE *ARE* GUY *FVWKS*", 0, 1, 0, 0, 0]], []],
  ["*", [], ["Ignored an unmatched '*'."]],
  ["***", [], ["Ignored an unmatched '*'."]],
  ["A * B", [["A * B", 0, 0, 0, 0, 0]], ["Ignored an unmatched '*'."]],
  ["A\\\\B", [["A\\\\B", 0, 0, 0, 0, 0]], []],
  ["A \\[0.5] B", [["A \\[0.5] B", 0, 0, 0, 0, 0]], []],
  ["A \\[0.5\\] B", [["A \\[0.5\\] B", 0, 0, 0, 0, 0]], []],
  ["X\\", [["X\\", 0, 0, 0, 0, 0]], []],
  ["A [0.5 B", [["A [0.5 B", 0, 0, 0, 0, 0]], []],
  ["A [x] [y] B", [["A [x] [y] B", 0, 0, 0, 0, 0]], ["Ignored unknown tag '[x]'.", "Ignored unknown tag '[y]'."]],
  ["A [ 1 / 4 b ] B", [["A", 0, 0, 0, 0.25, 0], ["B", 0, 0, 0, 0, 0]], []],
  ["A [1/0b] B", [["A [1/0b] B", 0, 0, 0, 0, 0]], ["Ignored pause '[1/0b]': division by zero."]],
  ["A [3.] B", [["A", 0, 0, 3, 0, 0], ["B", 0, 0, 0, 0, 0]], []],
  ["A [1.5 sec] B", [["A", 0, 0, 1.5, 0, 0], ["B", 0, 0, 0, 0, 0]], []],
  ["A [250 MS] B", [["A", 0, 0, 0.25, 0, 0], ["B", 0, 0, 0, 0, 0]], []],
  ["A [1 Seconds] B", [["A", 0, 0, 1, 0, 0], ["B", 0, 0, 0, 0, 0]], []],
  ["A [2 Beat] B", [["A", 0, 0, 0, 2, 0], ["B", 0, 0, 0, 0, 0]], []],
  ["A [x\ny] B", [["A [x", 0, 0, 0, 0, 1], ["y] B", 0, 0, 0, 0, 0]], []],
  ["[LAUGHS]", [], ["Ignored unknown tag '[LAUGHS]'."]],
  ["A [it's] B", [["A [it's] B", 0, 0, 0, 0, 0]], ["Ignored unknown tag \"[it's]\"."]],
  ["LINE ONE\r\nLINE TWO", [["LINE ONE", 0, 0, 0, 0, 1], ["LINE TWO", 0, 0, 0, 0, 0]], []],
  ["A\n\nB", [["A", 0, 0, 0, 0, 1], ["B", 0, 0, 0, 0, 0]], []],
  ["A\n|B", [["A", 1, 0, 0, 0, 1], ["B", 0, 0, 0, 0, 0]], []],
  ["*A\nB*", [["*A", 0, 1, 0, 0, 1], ["B*", 0, 1, 0, 0, 0]], []],
  ["A | *B\nC* | D", [["A", 1, 0, 0, 0, 0], ["*B", 0, 1, 0, 0, 1], ["C*", 1, 1, 0, 0, 0], ["D", 0, 0, 0, 0, 0]], []],
  ["A\rB", [["A", 0, 0, 0, 0, 1], ["B", 0, 0, 0, 0, 0]], []],
  ["WE  ARE   LEGION", [["WE  ARE   LEGION", 0, 0, 0, 0, 0]], []],
  ["  padded  ", [["padded", 0, 0, 0, 0, 0]], []],
  ["tab\tseparated | words", [["tab\tseparated", 1, 0, 0, 0, 0], ["words", 0, 0, 0, 0, 0]], []],
  ["ONE [30] TWO", [["ONE", 0, 0, 30, 0, 0], ["TWO", 0, 0, 0, 0, 0]], []],
  ["ONE [30.5] TWO", "pause_too_long"],
  ["ONE [64b] TWO", [["ONE", 0, 0, 0, 64, 0], ["TWO", 0, 0, 0, 0, 0]], []],
  ["ONE [65b] TWO", "pause_too_long"],
  ["ONE [20] [20] TWO", "pause_too_long"],
  ["ONE [20] TWO [20] THREE", [["ONE", 0, 0, 20, 0, 0], ["TWO", 0, 0, 20, 0, 0], ["THREE", 0, 0, 0, 0, 0]], []],
  ["A | ... | B", [["A", 1, 0, 0, 0, 0], ["B", 0, 0, 0, 0, 0]], []],
  ["... | A", [["A", 0, 0, 0, 0, 0]], []],
  ["A | ...", [["A", 1, 0, 0, 0, 0]], []],
  ["?!", [], []],
  ["日本語 | テスト", [["日本語", 1, 0, 0, 0, 0], ["テスト", 0, 0, 0, 0, 0]], []],
  ["\"QUOTED\" | *IT'S*", [["\"QUOTED\"", 1, 0, 0, 0, 0], ["*IT'S*", 0, 1, 0, 0, 0]], []],
  ["SIGNAL, *REMEMBER*.", [["SIGNAL, *REMEMBER*.", 0, 1, 0, 0, 0]], []],
]

describe('engine parity', () => {
  it.each(ENGINE.map((c) => [JSON.stringify(c[0]), c] as const))('%s', (_name, c) => {
    const got = parse(c[0])
    if (typeof c[1] === 'string') {
      expect(got.error?.code).toBe(c[1])
      return
    }
    expect(got.error).toBeNull()
    const want = c[1].map(([text, bb, th, s, b, lb]) => ({
      text,
      flags: { beat_break: bb === 1, throw: th === 1, pause_after_s: s, pause_after_beats: b },
      lineBreak: lb === 1,
    }))
    expect(got.segments).toEqual(want)
    expect(got.warnings).toEqual(c[2])
  })

  it('cuts every script into chip runs that join back into the script', () => {
    for (const [script] of ENGINE)
      expect(
        decorate(script)
          .map((d) => d.text)
          .join(''),
      ).toBe(script)
  })
})

describe('chips', () => {
  const kinds = (script: string) =>
    decorate(script).map((d) => (d.kind === 'text' ? `${d.echo ? 'ECHO' : 'text'}:${d.text}` : `${d.kind}:${d.text}`))

  it('marks beats, pauses and echoes', () => {
    expect(kinds('WE ARE | EXPECT *US*')).toEqual(['text:WE ARE ', 'beat:|', 'text: EXPECT ', 'star:*', 'ECHO:US', 'star:*'])
    expect(decorate('ONE [0.5] TWO')[1]).toMatchObject({ kind: 'pause', bare: true, seconds: 0.5, beats: 0, ignored: false })
    expect(decorate('ONE [2b] TWO')[1]).toMatchObject({ kind: 'pause', bare: false, seconds: 0, beats: 2 })
    expect(decorate('ONE [500ms] TWO')[1]).toMatchObject({ kind: 'pause', bare: false, seconds: 0.5 })
  })

  it('shows what the engine ignores', () => {
    expect(decorate('[1b] WE | GO')[0]).toMatchObject({ kind: 'pause', ignored: true })
    expect(decorate('| GO')[0]).toMatchObject({ kind: 'beat', ignored: true })
    expect(decorate('EXPECT *US')).toContainEqual({ kind: 'star', text: '*', echo: false, open: true, stray: true })
    expect(decorate('A [1/0b] B')[1]).toMatchObject({ kind: 'pause', ignored: true })
    expect(kinds('HI [LAUGHS] THERE')).toEqual(['text:HI ', 'tag:[LAUGHS]', 'text: THERE'])
    expect(kinds('A \\| B')).toEqual(['text:A ', 'escape:\\', 'text:| B'])
  })

  it('echoes exactly what the engine throws', () => {
    // A throw mark inside a word throws the whole word; nested stars cancel.
    expect(kinds('*FV*WKS')).toEqual(['star:*', 'ECHO:FV', 'star:*', 'ECHO:WKS'])
    expect(kinds('EXPECT **US**')).toEqual(['text:EXPECT ', 'star:*', 'star:*', 'text:US', 'star:*', 'star:*'])
    expect(
      decorate('EXPECT **US**')
        .filter((d) => d.kind === 'star')
        .every((d) => d.kind === 'star' && !d.echo),
    ).toBe(true)
    // An echo runs across a break; the spaces at the break stay outside the pill.
    expect(kinds('*EXPECT | US*')).toEqual(['star:*', 'ECHO:EXPECT', 'text: ', 'beat:|', 'text: ', 'ECHO:US', 'star:*'])
    expect(kinds('*EXPECT  US*')).toEqual(['star:*', 'ECHO:EXPECT  US', 'star:*'])
  })
})

describe('counts', () => {
  it('uses ECHO, not throw', () => {
    expect(summarizeShort('WE ARE GUY FVWKS | EXPECT *US*')).toBe('2 SEG · 1 BREAK · 1 ECHO')
    expect(summarize('WE ARE GUY FVWKS | EXPECT *US*')).toBe('2 segments · 1 beat break · 1 echo')
    expect(summarizeShort('A [1] B | *C* | *D*')).toBe('4 SEG · 2 BREAKS · 1 PAUSE · 2 ECHOES')
    expect(summarizeShort('ONE [500ms] TWO')).toBe('2 SEG · 1 PAUSE')
    expect(summarizeShort('')).toBe('EMPTY')
    expect(summarize('')).toBe('empty')
  })
})

/** "WE ARE‸ GUY" (caret) or "WE ⟦ARE⟧ GUY" (selection) → [text, selStart, selEnd]. */
function at(marked: string): [string, number, number] {
  const c = marked.indexOf('‸')
  if (c >= 0) return [marked.replace('‸', ''), c, c]
  const s = marked.indexOf('⟦')
  const e = marked.indexOf('⟧') - 1
  return [marked.replace('⟦', '').replace('⟧', ''), s, e]
}

/** The edited text with its new caret/selection marked the same way, or the refusal. */
function show(text: string, r: EditResult | Edit | null): string {
  if (r === null) return 'unchanged'
  if (isRefusal(r)) return `refused: ${r.refused}`
  const next = applyEdit(text, r)
  if (r.selStart === r.selEnd) return `${next.slice(0, r.selStart)}‸${next.slice(r.selStart)}`
  return `${next.slice(0, r.selStart)}⟦${next.slice(r.selStart, r.selEnd)}⟧${next.slice(r.selEnd)}`
}

const beat = (m: string) => show(at(m)[0], insertBeat(...at(m)))
const pause = (m: string, token: string) => show(at(m)[0], insertPause(...at(m), token))
const echo = (m: string) => show(at(m)[0], toggleEcho(...at(m)))
const back = (m: string) => show(at(m)[0], deleteToken(...at(m), 'backward'))
const fwd = (m: string) => show(at(m)[0], deleteToken(...at(m), 'forward'))

describe('⏎ BEAT BREAK', () => {
  it('inserts " | " at the caret and carries on after it', () => {
    expect(beat('WE ARE‸ GUY FVWKS')).toBe('WE ARE | ‸GUY FVWKS')
    expect(beat('WE ARE ‸GUY')).toBe('WE ARE | ‸GUY')
    expect(beat('WE ARE‸')).toBe('WE ARE | ‸')
    expect(beat('ONE‸\nTWO')).toBe('ONE |‸\nTWO')
    expect(beat('⟦WE ARE⟧ GUY')).toBe('WE ARE | ‸GUY')
  })

  it('never splits a word or a token, and stays outside an echo', () => {
    expect(beat('EXP‸ECT US')).toBe('EXPECT | ‸US')
    expect(beat("DO‸N'T STOP")).toBe("DON'T | ‸STOP")
    expect(beat('ONE [0‸.5] TWO')).toBe('ONE [0.5] | ‸TWO')
    expect(beat('EXPECT *US‸*')).toBe('EXPECT *US* | ‸')
    expect(beat('EXPECT *‸US*')).toBe('EXPECT | ‸*US*')
    // Between the words of an echo it's a real break inside the echo (the engine throws both parts).
    expect(beat('*EXPECT‸ US*')).toBe('*EXPECT | ‸US*')
  })

  it('refuses before the first words, where the engine would drop it', () => {
    expect(beat('‸WE ARE')).toMatch(/^refused: A beat break goes after words/)
    expect(beat('[1b] ‸WE ARE')).toMatch(/^refused/)
  })
})

describe('⏸ PAUSE', () => {
  it('inserts the pause like a beat break', () => {
    expect(pause('WE ARE‸ GUY', '[0.5b]')).toBe('WE ARE [0.5b] ‸GUY')
    expect(pause('WE ARE‸', '[1]')).toBe('WE ARE [1] ‸')
    expect(pause('W‸E ARE', '[2b]')).toBe('WE [2b] ‸ARE')
  })

  it('stays within the engine limits and ignores nothing silently', () => {
    expect(pause('‸WE ARE', '[1]')).toMatch(/^refused: A pause before the first words is ignored/)
    expect(pause('ONE‸ [64b] TWO', '[1b]')).toBe('refused: A pause in the script is too long. Keep pauses under 30 s or 64 beats.')
    const full = `${'A'.repeat(1996)} B`
    expect(pause(`${full}‸`, '[1]')).toMatch(/^refused: The script is at its 2,000-character limit/)
  })
})

describe('✺ ECHO WORD', () => {
  it('wraps the word at the caret', () => {
    expect(echo('EXPECT US‸')).toBe('EXPECT *US*‸')
    expect(echo('EXPECT U‸S')).toBe('EXPECT *U‸S*')
    expect(echo('EXPECT ‸US')).toBe('EXPECT *‸US*')
    expect(echo("‸DON'T STOP")).toBe("*‸DON'T* STOP")
  })

  it('grows a selection to whole words and leaves punctuation outside', () => {
    expect(echo('EXPECT ⟦US!⟧')).toBe('EXPECT *⟦US⟧*!')
    expect(echo('WE ARE G⟦UY FV⟧WKS')).toBe('WE ARE *⟦GUY FVWKS⟧*')
    expect(echo('⟦EXPECT | US⟧')).toBe('*⟦EXPECT | US⟧*')
  })

  it('toggles off an echo that is already there', () => {
    expect(echo('EXPECT *U‸S*')).toBe('EXPECT U‸S')
    expect(echo('EXPECT *US*‸')).toBe('EXPECT US‸')
    expect(echo('WE *ARE ⟦GUY⟧* FVWKS')).toBe('WE ARE ⟦GUY⟧ FVWKS')
    expect(echo('*EXPECT ‸ US*')).toBe('EXPECT ‸ US')
    // "*FV*WKS" already throws all of FVWKS (in-word marks throw the whole word).
    expect(echo('*FV*W‸KS')).toBe('FVW‸KS')
  })

  it('never nests: stray and cancelling stars around the word are cleaned up', () => {
    expect(echo('EXPECT **U‸S**')).toBe('EXPECT *U‸S*')
    expect(echo('EXPECT *U‸S')).toBe('EXPECT *U‸S*')
    // Echoes a selection overlaps merge into one.
    expect(echo('⟦EXPECT *U⟧S* NOW')).toBe('*⟦EXPECT US⟧* NOW')
    // A separate echo next to it stays separate (the engine throws both either way).
    expect(echo('⟦EXPECT⟧ *US NOW*')).toBe('*⟦EXPECT⟧* *US NOW*')
  })

  it('round-trips', () => {
    for (const m of ['EXPECT U‸S', 'WE ⟦ARE GUY⟧ FVWKS', 'A | B‸ | C', "*DON'T* ST‸OP"]) {
      const [text, s, e] = at(m)
      const once = toggleEcho(text, s, e)
      if (isRefusal(once)) throw new Error(once.refused)
      const mid = applyEdit(text, once)
      const twice = toggleEcho(mid, once.selStart, once.selEnd)
      if (isRefusal(twice)) throw new Error(twice.refused)
      expect(applyEdit(mid, twice)).toBe(text)
    }
  })

  it('refuses where there is no word', () => {
    expect(echo('ONE |‸ TWO')).toMatch(/^refused: Put the caret on a word/)
    expect(echo('ONE [2‸b] TWO')).toMatch(/^refused/)
    expect(echo('ONE ⟦|⟧ TWO')).toMatch(/^refused: Select words/)
  })
})

describe('Backspace / Delete on tokens', () => {
  it('removes a whole pause, tick or escape, and one of the spaces around it', () => {
    expect(back('ONE [0.5]‸ TWO')).toBe('ONE ‸TWO')
    expect(fwd('ONE ‸[0.5] TWO')).toBe('ONE ‸TWO')
    expect(back('ONE |‸ TWO')).toBe('ONE ‸TWO')
    expect(back('ONE|‸TWO')).toBe('ONE‸TWO')
    expect(back('A \\|‸ B')).toBe('A ‸B')
    expect(back('HI [LAUGHS]‸')).toBe('HI ‸')
  })

  it('unwraps an echo instead of deleting one hidden star', () => {
    expect(back('EXPECT *US*‸')).toBe('EXPECT US‸')
    expect(back('EXPECT *‸US*')).toBe('EXPECT ‸US')
    expect(fwd('EXPECT ‸*US*')).toBe('EXPECT ‸US')
    expect(fwd('EXPECT *US‸*')).toBe('EXPECT US‸')
    // A selection that takes one star takes its partner too.
    expect(back('⟦EXPECT *U⟧S* NOW')).toBe('‸S NOW')
  })

  it('leaves everything else to the key', () => {
    expect(back('ONE‸')).toBe('unchanged')
    expect(back('‸ONE')).toBe('unchanged')
    expect(fwd('ONE‸')).toBe('unchanged')
    expect(back('ONE [0.5‸] TWO')).toBe('unchanged')
    expect(back('⟦ONE⟧ TWO')).toBe('unchanged')
    expect(back('EXPECT *US‸')).toBe('unchanged')
  })
})
