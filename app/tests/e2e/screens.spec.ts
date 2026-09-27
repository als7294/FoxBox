import { expect, test } from '@playwright/test'
import { launchApp, waitReady, waitWipe, type Launched } from './app'

// Visual smoke test: walks every screen and saves screenshots to test-results/screens/.
let run: Launched

test.afterEach(async () => {
  await run?.app.close()
})

test('every screen renders', async () => {
  run = await launchApp()
  const { page } = run
  const shot = (name: string) => page.screenshot({ path: `test-results/screens/${name}.png` })
  await waitReady(page)
  await shot('01-studio-empty')

  const editor = page.getByTestId('script-editor')
  await editor.fill('WE ARE GUY FVWKS | EXPECT *US* [2b] REMEMBER')
  const cartridge = page.getByTestId('cartridge')
  await expect(cartridge).toHaveAttribute('data-state', 'preview', { timeout: 60_000 })
  await shot('02-studio-preview')

  await page.getByRole('button', { name: 'Open rack' }).click()
  await expect(page.getByRole('region', { name: 'Rack modules' })).toBeVisible()
  await shot('03-studio-rack-open')
  await page.getByRole('button', { name: 'Close rack' }).click()
  await expect(page.getByRole('region', { name: 'Rack modules' })).toHaveCount(0)

  await editor.press('Meta+Enter')
  await expect(cartridge).toHaveAttribute('data-state', 'ready', { timeout: 60_000 })
  await shot('04-studio-final')

  // Single-key shortcuts pause while typing: leave the editor first.
  await editor.blur()
  await page.keyboard.press('?')
  await expect(page.getByRole('dialog', { name: 'SHORTCUTS' })).toBeVisible()
  await shot('05-shortcuts')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'SHORTCUTS' })).toHaveCount(0)

  for (const screen of ['VAULT', 'SETLIST', 'VOICES', 'SETTINGS'] as const) {
    await page.getByRole('navigation').getByRole('button', { name: screen }).click()
    await expect(page.getByRole('heading', { name: screen, level: 1 })).toBeVisible()
    await waitWipe(page)
    await shot(`06-${screen.toLowerCase()}`)
  }
})
