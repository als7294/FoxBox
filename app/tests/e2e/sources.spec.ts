import { expect, test } from '@playwright/test'
import { copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { launchApp, waitReady, type Launched } from './app'

// Recording and import go through the multipart upload: renderer FormData → IPC proxy → engine ingest.
let run: Launched

test.afterEach(async () => {
  await run?.app.close()
})

// ponytail: stale since 1.4 (f6d2d9b): takes are recorded on VISUALS' voice panel (TAKE → STUDIO), and the Studio's RECORD is
// a link there, not a tab. Rewrite it on VISUALS in 1.5.1.
test.skip('record a take (synthetic mic), then render it', async () => {
  // FVWKS_FAKE_MIC skips the macOS permission ask; getUserMedia gets a 220 Hz tone, so no real device or
  // OS prompt is involved. Everything after it (worklet capture, WAV, upload, render) is the real pipeline.
  run = await launchApp({ FVWKS_FAKE_MIC: '1' })
  const { app, page } = run
  await app.context().addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      const ctx = new AudioContext()
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      const dest = ctx.createMediaStreamDestination()
      osc.frequency.value = 220
      gain.gain.value = 0.3
      osc.connect(gain).connect(dest)
      osc.start()
      return dest.stream
    }
  })
  await page.reload()
  await waitReady(page)
  await page.getByRole('tab', { name: 'RECORD' }).click()
  await page.getByRole('button', { name: 'Start recording' }).click()
  // 3-beat count-in at 140 BPM, then recording.
  await expect(page.getByRole('button', { name: 'Stop recording' })).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(1_500)
  await page.getByRole('button', { name: 'Stop recording' }).click()
  const take = page.getByRole('list', { name: 'Takes' }).getByRole('listitem').first()
  await expect(take).toContainText('TAKE 01')
  // Uploaded and in use as the source.
  await expect(take).toContainText('IN USE', { timeout: 30_000 })
  // Uploading the take renders it straight away.
  await expect(page.getByTestId('cartridge')).toHaveAttribute('data-state', 'preview', { timeout: 30_000 })
})

test('import a file: WAV goes up as-is; an unknown extension is decoded to WAV first', async () => {
  run = await launchApp()
  const { page, dirs } = run
  await waitReady(page)
  await page.getByRole('tab', { name: 'IMPORT' }).click()
  const fixture = resolve(__dirname, '../../../fixtures/voices/hands_up.wav')

  await page.getByRole('tabpanel', { name: 'IMPORT' }).locator('input[type="file"]').setInputFiles(fixture)
  const source = page.getByRole('status').filter({ hasText: 'SOURCE · IN USE' })
  await expect(source).toContainText('hands_up.wav', { timeout: 30_000 })
  await expect(source).toContainText(/\d+\.\d s · sent as-is/)
  await expect(page.getByTestId('cartridge')).toHaveAttribute('data-state', 'preview', { timeout: 30_000 })

  // Chromium decodes by content, so a WAV named .m4a exercises the Web Audio → WAV conversion path.
  const disguised = join(dirs.root, 'voice-memo.m4a')
  copyFileSync(fixture, disguised)
  await page.getByRole('tabpanel', { name: 'IMPORT' }).locator('input[type="file"]').setInputFiles(disguised)
  await expect(source).toContainText('voice-memo.m4a', { timeout: 30_000 })
  await expect(source).toContainText('converted to WAV')
})
