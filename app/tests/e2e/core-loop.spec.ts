import { expect, test } from '@playwright/test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { launchApp, waitReady, type Launched } from './app'

let run: Launched

test.afterEach(async () => {
  await run?.app.close()
})

test('launch → type → render → export → file exists', async () => {
  run = await launchApp()
  const { page, dirs } = run

  // Launch: the engine comes up READY and the boot sequence hands over.
  await waitReady(page)

  // Type: the header counts the markup (echo = the API's throw); when typing pauses, the line previews itself.
  const editor = page.getByTestId('script-editor')
  await editor.fill('WE ARE GUY FVWKS | EXPECT *US*')
  await expect(page.getByText(/2 SEG · 1 BREAK · 1 ECHO/)).toBeVisible()
  const cartridge = page.getByTestId('cartridge')
  await expect(cartridge).toHaveAttribute('data-state', 'preview', { timeout: 60_000 })
  await expect(page.getByRole('status', { name: 'Fit' })).toContainText(/LOCKED|SHORT|STRETCHED|EXTENDED|OVERFLOW/)
  // AUTO bars (v0.2, the default): the engine picked a standard count, and the picker shows it ("AUTO · N").
  await expect(page.getByRole('radiogroup', { name: 'Bars' }).getByRole('radio', { name: /^AUTO, (1|2|4|8|16) bars$/ })).toHaveAttribute('aria-checked', 'true')

  // Final render (⌘↩ works while typing): the wet file is auto-exported and the cartridge becomes draggable.
  await editor.press('Meta+Enter')
  await expect(cartridge).toHaveAttribute('data-state', 'ready', { timeout: 60_000 })
  const filename = (await page.getByTestId('cartridge-filename').textContent())?.trim() ?? ''
  expect(filename).toMatch(/^[a-z0-9-]+_.*\.(aiff|wav)$/)

  // Export options (EXPORT ▾ → sheet → WAV → Export): the WAV variant lands in the export folder.
  await page.getByTestId('export-options').click()
  await page.getByRole('radio', { name: 'WAV' }).click()
  await page.getByTestId('export-confirm').click()
  const row = page.getByTestId('exported-file').first()
  await expect(row).toBeVisible()
  const path = await row.getAttribute('data-path')
  expect(path).toBeTruthy()
  expect(path!.startsWith(dirs.exports) || path!.includes('fvwks-e2e-')).toBe(true)

  // The file exists on disk and is a real WAV with integer PCM (format tag 1, never 0xFFFE).
  expect(existsSync(path!)).toBe(true)
  expect(statSync(path!).size).toBeGreaterThan(1000)
  const header = readFileSync(path!).subarray(0, 36)
  expect(header.toString('ascii', 0, 4)).toBe('RIFF')
  expect(header.readUInt16LE(20)).toBe(1)

  // The auto-exported AIFF from the final render exists too.
  expect(existsSync(`${dirs.exports}/${filename}`)).toBe(true)
})
