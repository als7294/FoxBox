import { expect, test } from '@playwright/test'
import { launchApp, waitReady, type Launched } from './app'

let run: Launched

test.afterEach(async () => {
  await run?.app.close()
})

test('the engine is restarted after a crash and the studio keeps working', async () => {
  run = await launchApp()
  const { page } = run
  await waitReady(page)

  await page.getByTestId('script-editor').fill('WE ARE GUY FVWKS | EXPECT *US*')
  // Typing pauses → preview render.
  await expect(page.getByTestId('cartridge')).toHaveAttribute('data-state', 'preview', { timeout: 60_000 })

  // Crash the engine.
  const before = await page.evaluate(() => window.fvwks!.getEngineStatus())
  expect(before.pid).toBeGreaterThan(0)
  process.kill(before.pid!, 'SIGKILL')
  const status = page.getByTestId('engine-status')
  await expect(status).toHaveAttribute('data-state', /restarting|starting|offline/, { timeout: 10_000 })
  await expect(status).toHaveAttribute('data-state', 'ready', { timeout: 60_000 })
  const after = await page.evaluate(() => window.fvwks!.getEngineStatus())
  expect(after.pid).not.toBe(before.pid)
  expect(after.restarts).toBe(1)

  // The new engine has none of the old (in-memory) sources; the next render recreates them.
  await page.getByRole('radio', { name: '8', exact: true }).click()
  await expect(page.getByRole('status', { name: 'Fit' })).toContainText(/8 BARS @ 140/, { timeout: 30_000 })
  await expect(page.getByRole('alert')).toHaveCount(0)
})
