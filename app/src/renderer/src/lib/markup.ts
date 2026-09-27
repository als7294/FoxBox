/**
 * Script markup: a port of the engine's parser (engine/voice/src/fvwks_voice/markup.py) for the editors'
 * chips, header counts and insert buttons. fixtures/markup_cases.json keeps the two in agreement.
 *   |        beat break: the next part starts on the next beat
 *   [0.5]    pause in seconds ([0.5s], [500ms])      [2b]  pause in beats ([1/2b], [2 beats])
 *   *word*   echo (the API's `throw`): a delay/reverb throw; it may cover several words and breaks
 *   newline  a new part with a short natural gap      \|  \*  \[  \]  \\  literal characters
 * Like the engine, the parser is lenient: an unmatched `*`, an unknown [tag] or a leading pause is dropped
 * with a warning. Only a pause over 30 s / 64 beats is an error.
 */

export const MAX_SCRIPT_CHARS = 2000
export const MAX_PAUSE_S = 30
export const MAX_PAUSE_BEATS = 64

const PAUSE_RE = /\[\s*(\d+(?:\.\d*)?|\.\d+)(?:\s*\/\s*(\d+))?\s*(ms|s|secs?|seconds?|b|beats?)?\s*\]/iy
const WS_RE = /\s+/g
const ALNUM_RE = /[\p{L}\p{N}]/u
const WORD_TAIL_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]*)*$/u // "DON'" in "*DON'*T" still ends mid-word
const WORD_HEAD_RE = /^(?:['’]?[\p{L}\p{N}]+)+/u
/** A word for the insert buttons: letters and digits, with apostrophes inside ("DON'T"). */
const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu
const ESCAPABLE = '|*[]\\'

export interface SegmentFlags {
  beat_break: boolean
  throw: boolean
  pause_after_s: number
  pause_after_beats: number
}

/** One engine Segment. `text` is the chunk's source with its markup, as in fixtures/markup_cases.json. */
export interface MarkupSegment {
  text: string
  flags: SegmentFlags
  /** Followed by a newline: a natural gap, not a contract flag. */
  lineBreak: boolean
}

export interface MarkupError {
  code: 'pause_too_long'
  message: string
  hint: string
}

export interface Parsed {
  segments: MarkupSegment[]
  warnings: string[]
  /** Set when the engine would refuse the script; its preview then fails with this error. */
  error: MarkupError | null
}

// -- lexer ---------------------------------------------------------------------------------------

type TokKind = 'text' | 'bar' | 'pause' | 'star' | 'newline'

interface Tok {
  kind: TokKind
  start: number
  end: number
  /** Text tokens only: the characters, with escapes resolved and each unknown tag read as one space. */
  text: string
  /** Text tokens only: the source index of each character of `text`. */
  at: number[]
  seconds: number
  beats: number
}

/** Source spans the lexer reads specially, kept for the chip layer and the token-aware keys. */
interface Span {
  start: number
  end: number
  kind: 'escape' | 'tag' | 'badPause'
}

const tok = (kind: TokKind, start: number, end: number): Tok => ({ kind, start, end, text: '', at: [], seconds: 0, beats: 0 })

function pauseOf(m: RegExpExecArray): [number, number] | null {
  let value = Number(m[1])
  if (m[2] !== undefined) {
    const den = Number(m[2])
    if (den === 0) return null
    value /= den
  }
  const unit = (m[3] ?? 's').toLowerCase()
  if (unit.startsWith('b')) return [0, value]
  if (unit === 'ms') return [value / 1000, 0]
  return [value, 0]
}

/** Python's repr() of a string, so the warnings read exactly like the engine's. */
function pyRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'"
  let out = ''
  for (const c of s) {
    if (c === '\\') out += '\\\\'
    else if (c === q) out += `\\${q}`
    else if (c === '\t') out += '\\t'
    else out += c
  }
  return q + out + q
}

function lex(src: string, warnings: string[], spans: Span[]): { toks: Tok[]; stray: number | null } {
  const toks: Tok[] = []
  let buf: Tok | null = null
  const flush = () => {
    if (buf) toks.push(buf)
    buf = null
  }
  const add = (c: string, start: number, end: number, at: number) => {
    buf ??= tok('text', start, end)
    buf.text += c
    buf.at.push(at)
    buf.end = end
  }
  const n = src.length
  let i = 0
  while (i < n) {
    const c = src[i]!
    if (c === '\\' && i + 1 < n && ESCAPABLE.includes(src[i + 1]!)) {
      add(src[i + 1]!, i, i + 2, i + 1)
      spans.push({ start: i, end: i + 1, kind: 'escape' })
      i += 2
      continue
    }
    if (c === '|' || c === '*' || c === '\n' || c === '\r') {
      flush()
      // \r\n and a lone \r are newlines too (the engine normalizes them before parsing).
      const end = c === '\r' && src[i + 1] === '\n' ? i + 2 : i + 1
      toks.push(tok(c === '|' ? 'bar' : c === '*' ? 'star' : 'newline', i, end))
      i = end
      continue
    }
    if (c === '[') {
      PAUSE_RE.lastIndex = i
      const m = PAUSE_RE.exec(src)
      if (m) {
        flush()
        const end = i + m[0].length
        const p = pauseOf(m)
        if (p) toks.push({ ...tok('pause', i, end), seconds: p[0], beats: p[1] })
        else {
          warnings.push(`Ignored pause ${pyRepr(m[0])}: division by zero.`)
          spans.push({ start: i, end, kind: 'badPause' })
        }
        i = end
        continue
      }
      const close = src.indexOf(']', i + 1)
      if (close !== -1 && !/[\n\r]/.test(src.slice(i, close))) {
        warnings.push(`Ignored unknown tag ${pyRepr(src.slice(i, close + 1))}.`)
        add(' ', i, close + 1, i)
        spans.push({ start: i, end: close + 1, kind: 'tag' })
        i = close + 1
        continue
      }
    }
    add(c, i, i + 1, i)
    i += 1
  }
  flush()

  // With an odd number of '*' the last one is dropped. It becomes empty text, which still opens a chunk.
  let stray: number | null = null
  const stars = toks.flatMap((t, k) => (t.kind === 'star' ? [k] : []))
  if (stars.length % 2) {
    warnings.push("Ignored an unmatched '*'.")
    const k = stars[stars.length - 1]!
    stray = toks[k]!.start
    toks[k] = tok('text', toks[k]!.start, toks[k]!.end)
  }
  return { toks, stray }
}

// -- parser --------------------------------------------------------------------------------------

const speakable = (text: string) => ALNUM_RE.test(text)

interface Raw {
  text: string
  at: number[]
  throw: boolean
}

interface Piece {
  text: string
  throw: boolean
}

/**
 * Collapses whitespace across the chunk, trims its ends and merges runs that share a throw state.
 * Punctuation- or space-only runs join the run before them, so a throw doesn't start on ", ".
 */
function piecesOf(raw: readonly Raw[]): Piece[] {
  const runs: Piece[] = []
  for (const r of raw) {
    let text = r.text.replace(WS_RE, ' ')
    const last = runs[runs.length - 1]
    if (last?.text.endsWith(' ') && text.startsWith(' ')) text = text.slice(1)
    if (!text) continue
    if (last && (last.throw === r.throw || !speakable(text))) last.text += text
    else runs.push({ text, throw: r.throw })
  }
  if (runs.length === 0) return []
  runs[0]!.text = runs[0]!.text.trimStart()
  runs[runs.length - 1]!.text = runs[runs.length - 1]!.text.trimEnd()
  const merged: Piece[] = []
  for (const r of runs) {
    if (!r.text) continue
    const last = merged[merged.length - 1]
    if (last && last.throw === r.throw) last.text += r.text
    else merged.push({ ...r })
  }
  // A throw mark inside a word ("*FV*WKS") throws the whole word.
  for (let k = 0; k < merged.length - 1; k++) {
    const a = merged[k]!
    const b = merged[k + 1]!
    const tail = WORD_TAIL_RE.exec(a.text)
    const head = WORD_HEAD_RE.exec(b.text)
    if (!tail || !head) continue
    if (a.throw) {
      a.text += head[0]
      b.text = b.text.slice(head[0].length)
    } else {
      a.text = a.text.slice(0, tail.index)
      b.text = tail[0] + b.text
    }
  }
  return merged.filter((p) => p.text)
}

interface Chunk {
  start: number
  end: number
  raw: Raw[]
  pieces: Piece[]
  breaks: Tok[]
}

interface Analysis extends Parsed {
  src: string
  toks: Tok[]
  chunks: Chunk[]
  spans: Span[]
  stray: number | null
  /** Bars and pauses before the first words; the engine drops them. */
  leading: Set<Tok>
}

// Python's round(x, 6). The two differ only on exact binary ties, which decimal pauses never produce.
const round6 = (x: number) => Number(x.toFixed(6))

function analyse(script: string): Analysis {
  const warnings: string[] = []
  const spans: Span[] = []
  const { toks, stray } = lex(script, warnings, spans)
  const chunks: Chunk[] = []
  const leading = new Set<Tok>()
  let cur: Chunk | null = null
  let throwing = false
  let leadPause = false
  const close = () => {
    if (!cur) return
    const pieces = piecesOf(cur.raw)
    if (pieces.length && speakable(pieces.map((p) => p.text).join(''))) chunks.push({ ...cur, pieces })
    cur = null
  }
  for (const t of toks) {
    if (t.kind === 'text' || t.kind === 'star') {
      if (t.kind === 'star') throwing = !throwing
      cur ??= { start: t.start, end: t.end, raw: [], pieces: [], breaks: [] }
      cur.end = t.end
      if (t.kind === 'text') cur.raw.push({ text: t.text, at: t.at, throw: throwing })
      continue
    }
    // A break closes the chunk. Unspeakable chunks vanish and pass their breaks on.
    close()
    if (chunks.length) chunks[chunks.length - 1]!.breaks.push(t)
    else if (t.kind !== 'newline') {
      leading.add(t)
      if (t.kind === 'pause') leadPause = true
    }
  }
  close()
  if (leadPause) warnings.push("Ignored a pause before the first words; use ARRANGE's first-word beat for pre-roll.")

  let error: MarkupError | null = null
  const segments = chunks.map((c): MarkupSegment => {
    const pauses = c.breaks.filter((b) => b.kind === 'pause')
    const secs = pauses.reduce((sum, b) => sum + b.seconds, 0)
    const beats = pauses.reduce((sum, b) => sum + b.beats, 0)
    if (!error && (secs > MAX_PAUSE_S || beats > MAX_PAUSE_BEATS)) {
      error = {
        code: 'pause_too_long',
        message: 'A pause in the script is too long.',
        hint: `Keep pauses under ${MAX_PAUSE_S} s or ${MAX_PAUSE_BEATS} beats.`,
      }
    }
    return {
      text: script.slice(c.start, c.end).trim(),
      flags: {
        beat_break: c.breaks.some((b) => b.kind === 'bar'),
        throw: c.pieces.some((p) => p.throw),
        pause_after_s: round6(secs),
        pause_after_beats: round6(beats),
      },
      lineBreak: c.breaks.some((b) => b.kind === 'newline'),
    }
  })
  return { src: script, toks, chunks, spans, stray, leading, segments, warnings, error }
}

/** Parses like the engine: the segments (one TTS call each), the warnings, and the refusal if there is one. */
export function parse(script: string): Parsed {
  const { segments, warnings, error } = analyse(script)
  return { segments, warnings, error }
}

/** Splits a script into segments the way the engine does (see fixtures/markup_cases.json). */
export function segmentsOf(script: string): MarkupSegment[] {
  return analyse(script).segments
}

// -- counts --------------------------------------------------------------------------------------

export interface MarkupCounts {
  segments: number
  breaks: number
  pauses: number
  echoes: number
}

export function countsOf(segments: readonly MarkupSegment[]): MarkupCounts {
  return {
    segments: segments.length,
    breaks: segments.filter((s) => s.flags.beat_break).length,
    pauses: segments.filter((s) => s.flags.pause_after_s || s.flags.pause_after_beats).length,
    echoes: segments.filter((s) => s.flags.throw).length,
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** "2 segments · 1 beat break · 1 echo", for screen readers and tooltips. */
export function summarize(script: string): string {
  const c = countsOf(segmentsOf(script))
  if (c.segments === 0) return 'empty'
  const parts = [plural(c.segments, 'segment', 'segments')]
  if (c.breaks) parts.push(plural(c.breaks, 'beat break', 'beat breaks'))
  if (c.pauses) parts.push(plural(c.pauses, 'pause', 'pauses'))
  if (c.echoes) parts.push(plural(c.echoes, 'echo', 'echoes'))
  return parts.join(' · ')
}

/** The editor header's short form: "2 SEG · 1 BREAK · 1 ECHO". */
export function summarizeShort(script: string): string {
  const c = countsOf(segmentsOf(script))
  if (c.segments === 0) return 'EMPTY'
  const parts = [`${c.segments} SEG`]
  if (c.breaks) parts.push(plural(c.breaks, 'BREAK', 'BREAKS'))
  if (c.pauses) parts.push(plural(c.pauses, 'PAUSE', 'PAUSES'))
  if (c.echoes) parts.push(plural(c.echoes, 'ECHO', 'ECHOES'))
  return parts.join(' · ')
}

// -- chip layer ----------------------------------------------------------------------------------

/**
 * The script cut into runs for the chip layer. Joining every `text` gives back the script character for
 * character, so the layer lines up exactly with the textarea above it.
 */
export type Deco =
  | { kind: 'text'; text: string; echo: boolean }
  /** `|`. `ignored` when it comes before the first words, where the engine drops it. */
  | { kind: 'beat'; text: string; ignored: boolean }
  /** `[0.5]`, `[2b]` and so on. `bare`: seconds written without a unit (the chip adds the "s"). */
  | { kind: 'pause'; text: string; seconds: number; beats: number; bare: boolean; ignored: boolean }
  /** `*`. `echo`: an edge of an echo pill. `stray`: the unmatched one the engine ignores. */
  | { kind: 'star'; text: string; echo: boolean; open: boolean; stray: boolean }
  /** The backslash of an escape. */
  | { kind: 'escape'; text: string }
  /** An unknown [tag] (the engine reads it as a space). */
  | { kind: 'tag'; text: string }
  | { kind: 'newline'; text: string }

/** Echo state per source index, taken from each chunk's final pieces so it matches what the engine throws. */
function echoMap(a: Analysis): Uint8Array {
  const echo = new Uint8Array(a.src.length)
  for (const c of a.chunks) {
    const clean = c.pieces.map((p) => p.text).join('')
    const flags: boolean[] = []
    for (const p of c.pieces) for (let k = 0; k < p.text.length; k++) flags.push(p.throw)
    // Walk the chunk's characters against its collapsed, trimmed text. Whatever doesn't line up is dropped whitespace.
    const aligned: { at: number; echo: boolean }[] = []
    const dropped: number[] = []
    let j = 0
    for (const r of c.raw) {
      for (let k = 0; k < r.text.length; k++) {
        const ch = r.text[k]!
        const at = r.at[k]!
        if (j < clean.length && (ch === clean[j] || (/\s/.test(ch) && clean[j] === ' '))) {
          aligned.push({ at, echo: flags[j]! })
          j++
        } else dropped.push(at)
      }
    }
    for (const x of aligned) if (x.echo) echo[x.at] = 1
    // Dropped whitespace between two echoed characters stays inside the pill.
    for (const at of dropped) {
      let prev = false
      let next = false
      for (const x of aligned) {
        if (x.at < at) prev = x.echo
        else {
          next = x.echo
          break
        }
      }
      if (prev && next) echo[at] = 1
    }
  }
  return echo
}

/** Matched `*` pairs as [opening, closing] source indices. Escaped stars and the stray one are left out. */
function pairsOf(a: Analysis): [number, number][] {
  const stars = a.toks.filter((t) => t.kind === 'star').map((t) => t.start)
  const pairs: [number, number][] = []
  for (let k = 0; k + 1 < stars.length; k += 2) pairs.push([stars[k]!, stars[k + 1]!])
  return pairs
}

export function decorate(script: string): Deco[] {
  const a = analyse(script)
  const echo = echoMap(a)
  const out: Deco[] = []
  const pairEcho = new Map<number, { echo: boolean; open: boolean }>()
  for (const [o, c] of pairsOf(a)) {
    let any = false
    for (let k = o + 1; k < c && !any; k++) any = echo[k] === 1
    pairEcho.set(o, { echo: any, open: true })
    pairEcho.set(c, { echo: any, open: false })
  }
  const spanAt = new Map(a.spans.map((s) => [s.start, s]))
  const tokAt = new Map(a.toks.filter((t) => t.kind !== 'text').map((t) => [t.start, t]))
  let i = 0
  while (i < script.length) {
    const t = tokAt.get(i)
    const span = spanAt.get(i)
    if (t?.kind === 'bar') {
      out.push({ kind: 'beat', text: '|', ignored: a.leading.has(t) })
      i = t.end
    } else if (t?.kind === 'pause') {
      const text = script.slice(t.start, t.end)
      out.push({ kind: 'pause', text, seconds: t.seconds, beats: t.beats, bare: !/[a-z]\s*\]$/i.test(text), ignored: a.leading.has(t) })
      i = t.end
    } else if (t?.kind === 'star') {
      const p = pairEcho.get(i)
      out.push({ kind: 'star', text: '*', echo: p?.echo ?? false, open: p?.open ?? true, stray: false })
      i = t.end
    } else if (t?.kind === 'newline') {
      out.push({ kind: 'newline', text: script.slice(t.start, t.end) })
      i = t.end
    } else if (span?.kind === 'badPause') {
      out.push({ kind: 'pause', text: script.slice(span.start, span.end), seconds: 0, beats: 0, bare: false, ignored: true })
      i = span.end
    } else if (span?.kind === 'tag') {
      out.push({ kind: 'tag', text: script.slice(span.start, span.end) })
      i = span.end
    } else if (span?.kind === 'escape') {
      out.push({ kind: 'escape', text: '\\' })
      i = span.end
    } else if (i === a.stray) {
      out.push({ kind: 'star', text: '*', echo: false, open: true, stray: true })
      i += 1
    } else {
      const isEcho = echo[i] === 1
      const last = out[out.length - 1]
      if (last?.kind === 'text' && last.echo === isEcho) last.text += script[i]
      else out.push({ kind: 'text', text: script[i]!, echo: isEcho })
      i += 1
    }
  }
  return out
}

// -- edits ---------------------------------------------------------------------------------------

/** Replaces [from, to) with `insert`, then selects [selStart, selEnd) (positions in the new text). */
export interface Edit {
  from: number
  to: number
  insert: string
  selStart: number
  selEnd: number
}

/** A button or key that does nothing at this spot, with the reason to show. */
export interface Refusal {
  refused: string
}

export type EditResult = Edit | Refusal

export function isRefusal(r: EditResult | null): r is Refusal {
  return r !== null && 'refused' in r
}

/** The text after an edit. */
export function applyEdit(text: string, e: Edit): string {
  return text.slice(0, e.from) + e.insert + text.slice(e.to)
}

interface Range {
  start: number
  end: number
}

function wordsOf(text: string): Range[] {
  return [...text.matchAll(WORD_RE)].map((m) => ({ start: m.index, end: m.index + m[0].length }))
}

/** Tokens a caret must not split, and that Backspace/Delete take whole: pauses, unknown tags and escapes. */
function atomsOf(a: Analysis): Range[] {
  return [
    ...a.toks.filter((t) => t.kind === 'pause').map((t) => ({ start: t.start, end: t.end })),
    ...a.spans.map((s) => ({ start: s.start, end: s.kind === 'escape' ? s.start + 2 : s.end })),
  ]
}

/** Words outside tokens (the "2b" inside [2b] isn't a word to echo). */
function freeWords(text: string, a: Analysis): Range[] {
  const atoms = atomsOf(a)
  return wordsOf(text).filter((w) => !atoms.some((t) => t.start < w.end && w.start < t.end))
}

/** Where a break goes for a caret at `pos`: never inside a word or a token, and outside an echo's edges. */
function breakPoint(text: string, a: Analysis, pos: number): number {
  const word = wordsOf(text).find((w) => w.start < pos && pos < w.end)
  if (word) pos = word.end
  const atom = atomsOf(a).find((t) => t.start < pos && pos < t.end)
  if (atom) pos = atom.end
  for (const [o, c] of pairsOf(a)) {
    if (pos === o + 1) return o
    if (pos === c) return c + 1
  }
  return pos
}

function insertBreak(text: string, selStart: number, selEnd: number, token: string, what: 'beat' | 'pause'): EditResult {
  const a = analyse(text)
  const pos = breakPoint(text, a, Math.max(selStart, selEnd))
  if (analyse(text.slice(0, pos)).segments.length === 0) {
    return {
      refused:
        what === 'beat'
          ? 'A beat break goes after words. Put the caret after the first word.'
          : "A pause before the first words is ignored. Use ARRANGE's first-word beat for pre-roll.",
    }
  }
  const before = text[pos - 1]
  const after = text[pos]
  const lead = before === undefined || /\s/.test(before) ? '' : ' '
  const trail = after !== undefined && /\s/.test(after) ? '' : ' '
  const insert = lead + token + trail
  const next = text.slice(0, pos) + insert + text.slice(pos)
  if (next.length > MAX_SCRIPT_CHARS)
    return { refused: `The script is at its ${MAX_SCRIPT_CHARS.toLocaleString('en-US')}-character limit.` }
  const err = parse(next).error
  if (err && !a.error) return { refused: `${err.message} ${err.hint}` }
  // Typing carries on after the break, past a space that was already there.
  const caret = pos + insert.length + (after === ' ' ? 1 : 0)
  return { from: pos, to: pos, insert, selStart: caret, selEnd: caret }
}

/** ⏎ BEAT BREAK / ⌥↩: ` | ` at the caret, moved to the end of any word it would split. */
export function insertBeat(text: string, selStart: number, selEnd: number): EditResult {
  return insertBreak(text, selStart, selEnd, '|', 'beat')
}

/** PAUSE ▾: `[0.5b]`, `[1]` and so on at the caret, moved to the end of any word it would split. */
export function insertPause(text: string, selStart: number, selEnd: number, token: string): EditResult {
  return insertBreak(text, selStart, selEnd, token, 'pause')
}

/**
 * Removes the stars at `cut` and wraps `wrap` (source positions) in one new pair, as a single edit.
 * `sel` is the selection to keep, in source positions. For a caret, `caretAfter` puts it past the new
 * closing star, so typing carries on outside the echo.
 */
function rewrap(text: string, cut: readonly number[], wrap: Range | null, sel: [number, number], caretAfter = false): Edit {
  const lo = Math.min(...cut, ...(wrap ? [wrap.start] : []))
  const hi = Math.max(...cut.map((c) => c + 1), ...(wrap ? [wrap.end] : []))
  let insert = ''
  for (let i = lo; i <= hi; i++) {
    if (wrap && (i === wrap.start || i === wrap.end)) insert += '*'
    if (i < hi && !cut.includes(i)) insert += text[i]
  }
  // An old position in the new text. `inside`: a position on a wrap edge lands inside the new pair.
  const map = (p: number, inside: boolean) => {
    let q = p - cut.filter((c) => c < p).length
    if (wrap && (wrap.start < p || (wrap.start === p && inside))) q += 1
    if (wrap && (wrap.end < p || (wrap.end === p && !inside))) q += 1
    return q
  }
  const [s, e] = sel
  if (s === e) {
    const caret = map(s, !caretAfter)
    return { from: lo, to: hi, insert, selStart: caret, selEnd: caret }
  }
  return { from: lo, to: hi, insert, selStart: map(s, true), selEnd: map(e, true) }
}

/** A word as the engine throws it: letters and digits, stars inside ("FV*WKS"), and `outer` takes the stars around it. */
interface EchoUnit extends Range {
  outer: Range
}

function echoUnits(text: string, a: Analysis, stars: ReadonlySet<number>): EchoUnit[] {
  const units: EchoUnit[] = []
  const onlyStars = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (!stars.has(i)) return false
    return to > from
  }
  for (const w of freeWords(text, a)) {
    const prev = units[units.length - 1]
    if (prev && onlyStars(prev.end, w.start)) prev.end = w.end
    else units.push({ ...w, outer: { ...w } })
  }
  for (const u of units) {
    let os = u.start
    while (stars.has(os - 1)) os -= 1
    let oe = u.end
    while (stars.has(oe)) oe += 1
    u.outer = { start: os, end: oe }
  }
  return units
}

/**
 * ✺ ECHO WORD / ⌘E: wraps the selection (grown to whole words, punctuation left outside) or the word at the
 * caret in `*…*`. When the engine already echoes those words, it removes that echo instead. Stars inside
 * or right next to the words go either way, so echoes never nest and `**US**` becomes `*US*`.
 */
export function toggleEcho(text: string, selStart: number, selEnd: number): EditResult {
  const a = analyse(text)
  const echo = echoMap(a)
  const pairs = pairsOf(a)
  const stars = new Set(a.toks.filter((t) => t.kind === 'star').map((t) => t.start))
  if (a.stray !== null) stars.add(a.stray)
  const units = echoUnits(text, a, stars)
  const [s, e] = selStart <= selEnd ? [selStart, selEnd] : [selEnd, selStart]
  let hit: EchoUnit[]
  if (s === e) {
    // The word the caret touches: the one just typed first, then the one right after the caret.
    const u = units.find((x) => x.outer.start < s && s <= x.outer.end) ?? units.find((x) => x.outer.start === s)
    if (!u) {
      // Between the words of an echo: remove that echo.
      const pair = pairs.find(([o, c]) => o <= s && s <= c + 1)
      if (pair) return rewrap(text, pair, null, [s, e])
      return { refused: 'Put the caret on a word, or select words, to echo them.' }
    }
    hit = [u]
  } else {
    hit = units.filter((u) => u.start < e && s < u.end)
    if (hit.length === 0) return { refused: 'Select words to echo them.' }
  }
  let lo = hit[0]!.outer.start
  let hi = hit[hit.length - 1]!.outer.end
  const echoed = (u: Range) => echo.subarray(u.start, u.end).some((x) => x === 1)
  const touching = pairs.filter(([o, c]) => (lo <= o && o < hi) || (lo <= c && c < hi) || (o < lo && hi <= c))
  const strays = (from: number, to: number) => (a.stray !== null && from <= a.stray && a.stray < to ? [a.stray] : [])
  const caretAfter = s === e && s === hit[0]!.outer.end
  if (hit.every(echoed)) return rewrap(text, [...touching.flat(), ...strays(lo, hi)], null, [s, e])
  // Echo on. Echoes it touches merge into the new one.
  for (const [o, c] of touching) {
    lo = Math.min(lo, o)
    hi = Math.max(hi, c + 1)
  }
  const inner = units.filter((u) => lo <= u.start && u.end <= hi)
  const wrap = { start: inner[0]!.start, end: inner[inner.length - 1]!.end }
  const cut = [...new Set([...touching.flat(), ...strays(lo, hi), ...[...stars].filter((x) => wrap.start < x && x < wrap.end)])]
  return rewrap(text, cut, wrap, s === e ? [s, e] : [wrap.start, wrap.end], caretAfter)
}

/**
 * Backspace right after a token, or Delete right before one, removes the whole token: a pause, an unknown
 * tag, an escape or a beat tick. On either star of an echo it unwraps the echo, so a hidden `*` never goes
 * alone and flips everything after it. Returns null to let the key do its usual thing.
 */
export function deleteToken(text: string, selStart: number, selEnd: number, direction: 'backward' | 'forward'): Edit | null {
  const a = analyse(text)
  const pairs = pairsOf(a)
  if (selStart !== selEnd) {
    // Deleting a selection that holds one star of an echo takes its partner too.
    const [s, e] = selStart <= selEnd ? [selStart, selEnd] : [selEnd, selStart]
    const inSel = (x: number) => s <= x && x < e
    const partners = pairs.filter(([o, c]) => inSel(o) !== inSel(c)).map(([o, c]) => (inSel(o) ? c : o))
    if (partners.length === 0) return null
    const lo = Math.min(s, ...partners)
    const hi = Math.max(e, ...partners.map((x) => x + 1))
    let insert = ''
    for (let i = lo; i < hi; i++) if (!inSel(i) && !partners.includes(i)) insert += text[i]
    const caret = s - partners.filter((x) => x < s).length
    return { from: lo, to: hi, insert, selStart: caret, selEnd: caret }
  }
  const pos = selStart
  const at = direction === 'backward' ? pos - 1 : pos
  if (at < 0 || at >= text.length) return null
  const pair = pairs.find(([o, c]) => o === at || c === at)
  if (pair) return rewrap(text, pair, null, [pos, pos])
  const units = [...atomsOf(a), ...a.toks.filter((t) => t.kind === 'bar').map((t) => ({ start: t.start, end: t.end }))]
  const unit = units.find((u) => (direction === 'backward' ? u.end === pos : u.start === pos))
  if (!unit) return null
  // Take one of the spaces around it as well, so " | " leaves no double space behind.
  const to = text[unit.start - 1] === ' ' && text[unit.end] === ' ' ? unit.end + 1 : unit.end
  return { from: unit.start, to, insert: '', selStart: unit.start, selEnd: unit.start }
}
