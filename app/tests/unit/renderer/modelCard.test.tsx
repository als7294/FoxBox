// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { Job, ModelInfo } from '../../../src/renderer/src/api/types'
import { ModelCard } from '../../../src/renderer/src/components/voices/ModelCard'
import { openModelsFor, orderModels, useModelFocus, WHISPER_ALIGNER } from '../../../src/renderer/src/components/voices/models'
import { useUi } from '../../../src/renderer/src/state/ui'

const model: ModelInfo = {
  id: 'qwen3-tts-voicedesign',
  name: 'Qwen3-TTS VoiceDesign',
  engine: 'qwen3',
  size_bytes: 3_400_000_000,
  installed: false,
  required: false,
  license: 'Apache-2.0',
  description: 'Persona designer.',
  update_available: false,
  default_selected: false,
}

const job = (patch: Partial<Job>): Job => ({
  id: 'job_1',
  kind: 'model_install',
  state: 'running',
  progress: 0.4,
  message: 'Downloading Qwen3-TTS VoiceDesign',
  items: [],
  result_ids: [],
  error: null,
  created_at: '',
  updated_at: '',
  ...patch,
})

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  cleanup()
  server.resetHandlers()
  useUi.setState({ installJobs: {} })
})
afterAll(() => server.close())

function renderCard(diskFree: number | null, props: { model?: ModelInfo; compact?: boolean } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ModelCard model={props.model ?? model} diskFree={diskFree} compact={props.compact} />
    </QueryClientProvider>,
  )
}

describe("Demucs' weights' terms (1.5.5)", () => {
  it("say so before the download, on the card and on the tile, and the engine's plain MIT never shows for them", () => {
    const stems = { ...model, id: 'stems-htdemucs', name: 'HT-Demucs stem splitter', license: 'MIT', size_bytes: 84_000_000 }
    renderCard(50e9, { model: stems })
    expect(screen.getByText(/Meta provides the trained weights for scientific purposes only/)).toBeInTheDocument()
    expect(screen.queryByText(/ MIT\. Runs locally/)).toBeNull()
    cleanup()
    renderCard(50e9, { model: stems, compact: true })
    expect(screen.getByText(/By downloading, you accept Meta's terms/)).toBeInTheDocument()
  })
})

const aligner: ModelInfo = {
  id: WHISPER_ALIGNER,
  name: 'Recording transcription',
  engine: 'asr',
  size_bytes: 2_895_074_212,
  installed: false,
  required: false,
  license: 'MIT',
  description: 'Transcribes recordings and places every word.',
  update_available: false,
  default_selected: false,
}

describe('ModelCard (model install job)', () => {
  it('shows free disk before/after, runs the job with progress, cancels, and finishes', async () => {
    let state: Job['state'] = 'running'
    let cancelled = false
    server.use(
      http.post('*/api/models/:id/install', () => HttpResponse.json(job({}))),
      http.get('*/api/jobs/:id', () => HttpResponse.json(job({ state, progress: state === 'done' ? 1 : 0.4 }))),
      http.post('*/api/jobs/:id/cancel', () => {
        cancelled = true
        return HttpResponse.json(job({ state: 'cancelled' }))
      }),
    )
    renderCard(20_000_000_000)
    expect(screen.getByText(/20\.0 GB free now → 16\.6 GB after/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Download 3\.4 GB/ }))
    const bar = await screen.findByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '40')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel download' }))
    await expect.poll(() => cancelled).toBe(true)
    state = 'done'
    await expect.poll(() => screen.queryByRole('progressbar'), { timeout: 3000 }).toBeNull()
  })

  it("reattaches to the engine's own install job (install_job_id) instead of offering Download", async () => {
    server.use(http.get('*/api/jobs/:id', ({ params }) => HttpResponse.json(job({ id: String(params.id), progress: 0.25 }))))
    renderCard(20_000_000_000, { model: { ...model, install_job_id: 'job_engine' } })
    const bar = await screen.findByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '25')
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull()
  })

  it('refuses to start when the download would leave less than 5 GB free', () => {
    renderCard(7_000_000_000)
    expect(screen.getByText(/must stay free/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Download/ })).toBeDisabled()
  })

  it('shows the engine\'s disk_full error with its hint', async () => {
    server.use(
      http.post('*/api/models/:id/install', () =>
        HttpResponse.json(
          job({
            state: 'error',
            error: { code: 'disk_full', message: 'Qwen3-TTS VoiceDesign needs 3.4 GB and 5 GB must stay free; 6.0 GB is available.', hint: 'Free up at least 2.4 GB, then try again.', retryable: false },
          }),
        ),
      ),
      http.get('*/api/jobs/:id', () =>
        HttpResponse.json(job({ state: 'error', error: { code: 'disk_full', message: 'needs more space', hint: 'Free up at least 2.4 GB, then try again.', retryable: false } })),
      ),
    )
    renderCard(null)
    fireEvent.click(screen.getByRole('button', { name: /Download/ }))
    expect(await screen.findByText(/Not enough disk space/)).toBeInTheDocument()
    expect(screen.getByText(/Free up at least 2\.4 GB/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
  })
})

describe('ModelCard compact (VOICES → MODELS strip)', () => {
  it('orders required models first, keeping the engine order inside each group', () => {
    const kokoro = { ...model, id: 'kokoro-82m', required: true }
    const denoise = { ...model, id: 'deepfilternet3', required: true }
    expect(orderModels([model, kokoro, aligner, denoise]).map((m) => m.id)).toEqual(['kokoro-82m', 'deepfilternet3', model.id, WHISPER_ALIGNER])
  })

  it('shows installed, downloadable and blocked tiles', () => {
    const { unmount } = renderCard(20_000_000_000, { model: { ...aligner, installed: true }, compact: true })
    expect(screen.getByText(/Installed/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull()
    unmount()
    renderCard(20_000_000_000, { model: aligner, compact: true })
    expect(screen.getByRole('button', { name: 'Download Recording transcription, 2.9 GB' })).toBeEnabled()
    cleanup()
    renderCard(6_000_000_000, { model: aligner, compact: true })
    expect(screen.getByRole('button', { name: /Download Recording transcription/ })).toBeDisabled()
    expect(screen.getByText(/Needs 7\.9 GB free/)).toBeInTheDocument()
  })

  it('runs the install job with progress and cancel', async () => {
    let cancelled = false
    server.use(
      http.post('*/api/models/:id/install', () => HttpResponse.json(job({ progress: 0.25 }))),
      http.get('*/api/jobs/:id', () => HttpResponse.json(job({ progress: 0.25 }))),
      http.post('*/api/jobs/:id/cancel', () => {
        cancelled = true
        return HttpResponse.json(job({ state: 'cancelled' }))
      }),
    )
    renderCard(20_000_000_000, { model: aligner, compact: true })
    fireEvent.click(screen.getByRole('button', { name: /Download Recording transcription/ }))
    const bar = await screen.findByRole('progressbar', { name: 'Downloading Recording transcription' })
    expect(bar).toHaveAttribute('aria-valuenow', '25')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel download of Recording transcription' }))
    await expect.poll(() => cancelled).toBe(true)
  })

  it('openModelsFor goes to VOICES and lights the model with its install button focused', () => {
    useUi.setState({ screen: 'studio', wipe: null })
    openModelsFor(WHISPER_ALIGNER)
    const ui = useUi.getState()
    expect(ui.screen === 'voices' || ui.wipe?.to === 'voices').toBe(true)
    const { container } = renderCard(20_000_000_000, { model: aligner, compact: true })
    const download = screen.getByRole('button', { name: /Download Recording transcription/ })
    expect(document.activeElement).toBe(download)
    expect(container.querySelector('[data-lit]')).not.toBeNull()
    // The request is used up: coming back to VOICES later doesn't light it again.
    expect(useModelFocus.getState().modelId).toBeNull()
  })
})

