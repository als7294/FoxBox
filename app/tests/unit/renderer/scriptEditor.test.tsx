// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse, passthrough } from 'msw'
import { setupServer } from 'msw/node'
import { useState, type ReactElement } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { SourceInfo } from '../../../src/renderer/src/api/types'
import { encodeWav } from '../../../src/renderer/src/audio/wav'
import { MarkupEditor } from '../../../src/renderer/src/components/source/MarkupEditor'
import { TranscriptEditor } from '../../../src/renderer/src/components/source/TranscriptEditor'
import { useModelFocus } from '../../../src/renderer/src/components/voices/models'
import { handlers } from '../../../src/renderer/src/mocks/handlers'
import { mockEngine } from '../../../src/renderer/src/mocks/mockEngine'
import { schedulePreview } from '../../../src/renderer/src/state/renderController'
import { useStudio } from '../../../src/renderer/src/state/studio'
import { useUi } from '../../../src/renderer/src/state/ui'

// The transcript editor re-renders after a save; here we only check that it asks for one.
vi.mock('../../../src/renderer/src/state/renderController', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/renderer/src/state/renderController')>()),
  schedulePreview: vi.fn(),
}))

const initialStudio = useStudio.getState()
const server = setupServer(
  ...handlers,
  http.all('*', () => passthrough()),
)
beforeAll(() => {
  mockEngine.latencyMs = 0
  server.listen({ onUnhandledRequest: 'bypass' })
})
afterEach(() => {
  cleanup()
  server.resetHandlers()
  mockEngine.transcriptModel = true
  mockEngine.transcriptMs = 1_500
  vi.mocked(schedulePreview).mockClear()
  useStudio.setState(initialStudio, true)
  useUi.setState({ screen: 'studio', wipe: null })
})
afterAll(() => server.close())

function Harness({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial)
  return <MarkupEditor value={value} onChange={setValue} label="Script" title="SCRIPT" bpm={120} testId="editor" />
}

function editor(): HTMLTextAreaElement {
  return screen.getByTestId('editor') as HTMLTextAreaElement
}

/** Focus the editor with the caret at `start` (or a selection up to `end`). */
function caret(start: number, end = start): HTMLTextAreaElement {
  const el = editor()
  el.focus()
  el.setSelectionRange(start, end)
  return el
}

function chips(container: HTMLElement): [string, string][] {
  return [...container.querySelectorAll('pre[aria-hidden="true"] [data-chip]')].map((el) => [
    el.getAttribute('data-chip')!,
    el.textContent!,
  ])
}

describe('MarkupEditor: chips', () => {
  it('draws the chips on exactly the typed characters', () => {
    const script = 'WE ARE | EXPECT *US* [0.5] GO [2b] NOW'
    const { container } = render(<Harness initial={script} />)
    const mirror = container.querySelector('pre[aria-hidden="true"]')!
    expect(mirror.textContent).toBe(`${script}\n`)
    expect(chips(container)).toEqual([
      ['beat', '|'],
      ['star', '*'],
      ['echo', 'US'],
      ['star', '*'],
      ['pause', '[0.5]'],
      ['pause', '[2b]'],
    ])
    const [bare, beats] = [...mirror.querySelectorAll('[data-chip="pause"]')]
    expect(bare).toHaveAttribute('data-bare')
    expect(beats).not.toHaveAttribute('data-bare')
    for (const star of mirror.querySelectorAll('[data-chip="star"]')) expect(star).toHaveAttribute('data-echo')
  })

  it('flags what the engine ignores', () => {
    const { container, unmount } = render(<Harness initial="[1b] GO | EXPECT *US" />)
    const mirror = container.querySelector('pre[aria-hidden="true"]')!
    expect(mirror.querySelector('[data-chip="pause"]')).toHaveAttribute('data-ignored')
    expect(mirror.querySelector('[data-chip="star"]')).toHaveAttribute('data-stray')
    unmount()
    render(<Harness initial={'HI [LAUGHS] THERE \\*'} />)
    expect(chips(document.body)).toEqual([
      ['tag', '[LAUGHS]'],
      ['escape', '\\'],
    ])
  })
})

describe('MarkupEditor: header', () => {
  it('counts parts in ECHO words and says when keys are paused', () => {
    render(<Harness initial="WE ARE GUY FVWKS | EXPECT *US*" />)
    expect(screen.getByText('2 SEG · 1 BREAK · 1 ECHO')).toBeInTheDocument()
    expect(screen.getByText('SCRIPT')).toBeInTheDocument()
    fireEvent.focus(editor())
    expect(screen.getByText('TYPING · KEYS PAUSED')).toBeInTheDocument()
    expect(useStudio.getState().typing).toBe(true)
    fireEvent.blur(editor())
    expect(screen.getByText('SCRIPT')).toBeInTheDocument()
    expect(useStudio.getState().typing).toBe(false)
  })

  it('shows the character count only near the limit', () => {
    render(<Harness initial={`${'A'.repeat(1596)} | B`} />)
    expect(screen.getByText('2 SEG · 1 BREAK · 1,600/2,000')).toBeInTheDocument()
  })
})

describe('MarkupEditor: insert buttons and keys', () => {
  it('⏎ BEAT BREAK inserts " | " at the caret, and ⌥↩ does the same', () => {
    render(<Harness initial="WE ARE GUY FVWKS" />)
    const beat = screen.getByRole('button', { name: 'BEAT BREAK' })
    expect(beat).toHaveAccessibleDescription('Next part starts on the next beat · ⌥↩')
    caret(6)
    fireEvent.click(beat)
    expect(editor()).toHaveValue('WE ARE | GUY FVWKS')
    expect(editor().selectionStart).toBe(9)
    caret(12)
    expect(fireEvent.keyDown(editor(), { key: 'Enter', altKey: true })).toBe(false)
    expect(editor()).toHaveValue('WE ARE | GUY | FVWKS')
  })

  it('refuses a break before the first words and says why', () => {
    render(<Harness initial="WE ARE" />)
    caret(0)
    fireEvent.click(screen.getByRole('button', { name: 'BEAT BREAK' }))
    expect(editor()).toHaveValue('WE ARE')
    expect(screen.getByRole('status')).toHaveTextContent(/goes after words/)
  })

  it('✺ ECHO WORD and ⌘E toggle an echo on the word at the caret', () => {
    render(<Harness initial="EXPECT US" />)
    const echo = screen.getByRole('button', { name: 'ECHO WORD' })
    expect(echo).toHaveAccessibleDescription(/Delay\/reverb throw on this word/)
    caret(9)
    fireEvent.click(echo)
    expect(editor()).toHaveValue('EXPECT *US*')
    expect(editor().selectionStart).toBe(11)
    expect(fireEvent.keyDown(editor(), { key: 'e', metaKey: true })).toBe(false)
    expect(editor()).toHaveValue('EXPECT US')
  })

  it('leaves ⌘↩ (final render) and ⌘⇧E (export) to the app', () => {
    render(<Harness initial="EXPECT US" />)
    caret(9)
    expect(fireEvent.keyDown(editor(), { key: 'Enter', metaKey: true })).toBe(true)
    expect(fireEvent.keyDown(editor(), { key: 'E', metaKey: true, shiftKey: true })).toBe(true)
    expect(editor()).toHaveValue('EXPECT US')
  })

  it('Backspace after a token removes all of it; Delete before a star unwraps the echo', () => {
    render(<Harness initial="ONE [0.5] TWO *US*" />)
    caret(9)
    expect(fireEvent.keyDown(editor(), { key: 'Backspace' })).toBe(false)
    expect(editor()).toHaveValue('ONE TWO *US*')
    expect(editor().selectionStart).toBe(4)
    caret(8)
    fireEvent.keyDown(editor(), { key: 'Delete' })
    expect(editor()).toHaveValue('ONE TWO US')
    // Ordinary characters are left to the browser.
    caret(3)
    expect(fireEvent.keyDown(editor(), { key: 'Backspace' })).toBe(true)
  })

  it('⏸ PAUSE ▾ is a keyboard menu', async () => {
    render(<Harness initial="WE ARE GUY" />)
    caret(6)
    const pause = screen.getByRole('button', { name: /PAUSE/ })
    expect(pause).toHaveAttribute('aria-haspopup', 'menu')
    expect(pause).toHaveAccessibleDescription('Silence here')
    pause.focus()
    fireEvent.keyDown(pause, { key: 'ArrowDown' })
    const menu = await screen.findByRole('menu', { name: 'Pause length' })
    expect(pause).toHaveAttribute('aria-expanded', 'true')
    const items = within(menu).getAllByRole('menuitem')
    expect(items.map((i) => i.querySelector('b')?.textContent)).toEqual(['[0.5b]', '[1b]', '[2b]', '[0.5]', '[1]'])
    expect(items[0]).toHaveTextContent('½ beat')
    expect(items[1]).toHaveTextContent('0.50 s') // 1 beat at 120 BPM
    await waitFor(() => expect(items[0]).toHaveFocus())
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    await waitFor(() => expect(items[1]).toHaveFocus())
    fireEvent.keyDown(menu, { key: 'End' })
    await waitFor(() => expect(items[4]).toHaveFocus())
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    await waitFor(() => expect(items[0]).toHaveFocus())
    fireEvent.keyDown(menu, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(pause).toHaveFocus()
    // Pick one: it goes in at the caret the text had.
    fireEvent.click(pause)
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: /2 beats/ }))
    expect(editor()).toHaveValue('WE ARE [2b] GUY')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})

// -------------------------------------------------------------------------------------------------
// TranscriptEditor against the MSW mock engine (v0.3 transcripts)

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

function wav(seconds = 1.2): ArrayBuffer {
  const ch = new Float32Array(Math.round(seconds * 48_000)).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 220 * i) / 48_000))
  return encodeWav({ sampleRate: 48_000, channels: [ch] }, 16)
}

/** A recording take in the engine and the Studio (RECORD tab), still being transcribed. */
function recording(): SourceInfo {
  const info = mockEngine.upload(wav(), 'recording', 'take 1')
  useStudio.setState({
    tab: 'record',
    source: info,
    sourceKey: info.id,
    takes: [
      { id: 't1', name: 'take 1', durationS: 1.2, createdAt: 0, wav: new Blob(), peakDb: -10, source: info, status: 'ready', error: null },
    ],
    activeTakeId: 't1',
  })
  return info
}

describe('TranscriptEditor', () => {
  it('renders only for a recording or an import', () => {
    const { container } = renderWithClient(<TranscriptEditor />)
    expect(container).toBeEmptyDOMElement()
  })

  it('reads TRANSCRIBING… until the words arrive; an edit saves as the transcript', async () => {
    mockEngine.transcriptMs = 300
    recording()
    renderWithClient(<TranscriptEditor />)
    const ed = screen.getByTestId('transcript-editor')
    expect(screen.getByRole('status')).toHaveTextContent('TRANSCRIBING…')
    expect(ed).toHaveAttribute('readonly')
    await waitFor(() => expect(ed).toHaveValue('WE ARE GUY FVWKS'), { timeout: 5_000 })
    expect(ed).not.toHaveAttribute('readonly')
    expect(useStudio.getState().source?.transcript_state).toBe('done')
    expect(useStudio.getState().takes[0]?.source?.script).toBe('WE ARE GUY FVWKS')

    // Mark it up like a script. Leaving the editor saves at once (typing alone saves after a 1.3 s pause).
    fireEvent.focus(ed)
    fireEvent.change(ed, { target: { value: 'WE ARE | GUY *FVWKS*' } })
    fireEvent.blur(ed)
    expect(await screen.findByText('SAVED')).toBeInTheDocument()
    const source = useStudio.getState().source!
    expect(source.script).toBe('WE ARE | GUY *FVWKS*')
    expect(source.segments.map((s) => [s.text, s.flags?.beat_break, s.flags?.throw])).toEqual([
      ['WE ARE', true, false],
      ['GUY *FVWKS*', false, true],
    ])
    expect(useStudio.getState().sourceKey).toBe(source.id)
    expect(useStudio.getState().takes[0]?.source?.script).toBe('WE ARE | GUY *FVWKS*')
    expect(schedulePreview).toHaveBeenCalledWith(0)
  })

  it('saves after a pause in typing', async () => {
    mockEngine.transcriptMs = 300
    recording()
    renderWithClient(<TranscriptEditor />)
    const ed = screen.getByTestId('transcript-editor')
    await waitFor(() => expect(ed).toHaveValue('WE ARE GUY FVWKS'), { timeout: 5_000 })
    fireEvent.change(ed, { target: { value: 'WE ARE GUY | FVWKS' } })
    await waitFor(() => expect(useStudio.getState().source?.script).toBe('WE ARE GUY | FVWKS'), { timeout: 4_000 })
    expect(screen.getByText('SAVED')).toBeInTheDocument()
  })

  it('explains a missing aligner model (503) and opens VOICES on its install tile', async () => {
    mockEngine.transcriptModel = false
    mockEngine.transcriptMs = 300
    recording()
    renderWithClient(<TranscriptEditor />)
    const ed = screen.getByTestId('transcript-editor')
    // The engine couldn't transcribe it: type the words yourself.
    await waitFor(() => expect(ed).not.toHaveAttribute('readonly'), { timeout: 5_000 })
    expect(screen.getByText(/couldn.t transcribe this take/)).toBeInTheDocument()
    fireEvent.change(ed, { target: { value: 'WE ARE GUY FVWKS' } })
    fireEvent.blur(ed)
    const open = await screen.findByRole('button', { name: 'INSTALL IN VOICES' })
    expect(screen.getByRole('note')).toHaveTextContent(/whisper-aligner/)
    expect(ed).toHaveAttribute('readonly')
    fireEvent.click(open)
    // VOICES → MODELS with the aligner's tile lit (openModelsFor).
    expect(useUi.getState().screen).toBe('voices')
    expect(useModelFocus.getState().modelId).toBe('whisper-aligner')
  })

  it('goes read-only on an engine without transcript editing (501)', async () => {
    server.use(
      http.put('*/api/sources/:sourceId/transcript', () =>
        HttpResponse.json(
          { error: { code: 'not_implemented', message: 'Not implemented.', hint: null, retryable: false } },
          { status: 501 },
        ),
      ),
    )
    mockEngine.transcriptMs = 300
    recording()
    renderWithClient(<TranscriptEditor />)
    const ed = screen.getByTestId('transcript-editor')
    await waitFor(() => expect(ed).toHaveValue('WE ARE GUY FVWKS'), { timeout: 5_000 })
    fireEvent.change(ed, { target: { value: 'WE ARE | GUY FVWKS' } })
    fireEvent.blur(ed)
    expect(await screen.findByText('Transcript editing arrives with the engine update.')).toBeInTheDocument()
    expect(ed).toHaveAttribute('readonly')
  })

  it('shows any other refusal and stays editable', async () => {
    server.use(
      http.put('*/api/sources/:sourceId/transcript', () =>
        HttpResponse.json(
          {
            error: {
              code: 'align_failed',
              message: "The words didn't line up with the audio.",
              hint: 'Check the transcript.',
              retryable: false,
            },
          },
          { status: 422 },
        ),
      ),
    )
    mockEngine.transcriptMs = 300
    recording()
    renderWithClient(<TranscriptEditor />)
    const ed = screen.getByTestId('transcript-editor')
    await waitFor(() => expect(ed).toHaveValue('WE ARE GUY FVWKS'), { timeout: 5_000 })
    fireEvent.change(ed, { target: { value: 'SOMETHING ELSE ENTIRELY' } })
    fireEvent.blur(ed)
    expect(await screen.findByText(/The words didn't line up with the audio. Check the transcript./)).toBeInTheDocument()
    expect(ed).not.toHaveAttribute('readonly')
    expect(useStudio.getState().source?.script).toBe('WE ARE GUY FVWKS')
  })
})
