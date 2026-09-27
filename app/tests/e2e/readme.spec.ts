import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { launchApp, waitReady, waitWipe, type Launched } from './app'

// README screenshots of FoxBox against the real engine at 1512×982. Opt-in:
//   FVWKS_README_SHOTS=docs/screens/readme npx playwright test readme
// Writes the 01…09 PNGs plus `_core-*.png` (crops for the 03-presets contact sheet) and `_gif/*.png` (voice core
// frames for studio.gif); those two are composed afterwards and the underscore files are not committed.
const OUT = process.env.FVWKS_README_SHOTS ? resolve(process.env.FVWKS_README_SHOTS) : null
const HERO = 'REMEMBER, REMEMBER [0.5] THE SIGNAL NEVER DIES | WE DO NOT FORGIVE | *EXPECT US*'
const LINES = [
  'WE ARE GUY FVWKS | EXPECT *US*',
  'REMEMBER, REMEMBER [0.5] THE SIGNAL NEVER DIES',
  'NO NAMES. NO FACES. [0.5] ONLY *BASS*',
  'WE DO NOT FORGIVE [2b] WE DO NOT FORGET',
  'LIGHTS OFF | PHONES DOWN',
]

let run: Launched

test.skip(!OUT, 'set FVWKS_README_SHOTS=<dir> to capture the README screenshots')
test.setTimeout(900_000)

test.afterEach(async () => {
  await run?.app.close()
})

/** No toasts in the frame (they can carry the temporary export path). */
async function noToasts(page: Page) {
  await expect(page.locator('[aria-live="polite"][data-tone]')).toHaveCount(0, { timeout: 15_000 })
}

async function nav(page: Page, screen: string) {
  await page.getByRole('navigation').getByRole('button', { name: screen }).click()
  await waitWipe(page)
  await page.waitForTimeout(400)
}

test('README screenshots', async () => {
  run = await launchApp()
  const { app, page } = run
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1512, 982))
  mkdirSync(join(OUT!, '_gif'), { recursive: true })
  const shot = (name: string) => page.screenshot({ path: join(OUT!, name) })

  // 09: the boot sequence, mid-way (after the title scramble has settled).
  await page.waitForTimeout(2_100)
  await shot('09-boot.png')
  await waitReady(page)
  await page.waitForTimeout(1_200)

  // 06 + 05: a five-line setlist rendered as a batch fills the VAULT too.
  await nav(page, 'SETLIST')
  const pasteToggle = page.getByRole('button', { name: '+ PASTE MANY' })
  if ((await pasteToggle.getAttribute('aria-expanded')) !== 'true') await pasteToggle.click()
  await page.getByLabel('Paste lines', { exact: true }).fill(LINES.join('\n'))
  await page.getByRole('button', { name: 'ADD LINES' }).click()
  await page.getByLabel('PLAYLIST NAME').fill('FoxBox Drops')
  const renderAll = page.getByTestId('render-all')
  await renderAll.click()
  await expect(page.getByTestId('setlist-summary')).toHaveText(`${LINES.length} LINES · ${LINES.length} DONE`, { timeout: 240_000 })
  await expect(renderAll).toHaveText('RENDER ALL', { timeout: 60_000 })
  await page.mouse.move(2, 2)
  await noToasts(page)
  await shot('06-setlist.png')

  await nav(page, 'VAULT')
  await expect(page.getByRole('table', { name: 'Vault' }).getByRole('row')).toHaveCount(LINES.length + 1, { timeout: 30_000 })
  await page.mouse.move(2, 2)
  await noToasts(page)
  await shot('05-vault.png')

  // 01: the hero, mid-playback on PACT.
  await nav(page, 'STUDIO')
  const editor = page.getByTestId('script-editor')
  await editor.fill(HERO)
  await editor.blur()
  await page.keyboard.press('1')
  const cartridge = page.getByTestId('cartridge')
  await expect(cartridge).toHaveAttribute('data-state', 'preview', { timeout: 90_000 })
  await expect(page.getByTestId('engine-status')).toHaveAttribute('data-state', 'ready')
  await page.waitForTimeout(1_500) // the reveal sweep
  await noToasts(page)
  await page.mouse.move(2, 2)
  await page.keyboard.press(' ')
  await page.waitForTimeout(1_700)
  await shot('01-studio.png')

  // Voice core frames for studio.gif (PACT, about 6 s at ~12 fps), then the preset crops for 03.
  // The whole panel: the canvas plus its DOM captions (word, BAR, HIGH/MID/LOW, PITCH/RMS).
  const core = page.locator('div:has(> canvas[aria-label="Voice core visualiser"])').first()
  await page.keyboard.press(' ') // stop, then play from the top for the GIF
  await page.waitForTimeout(300)
  await page.keyboard.press(' ')
  const t0 = Date.now()
  for (let i = 0; Date.now() - t0 < 6_000; i++) {
    await core.screenshot({ path: join(OUT!, '_gif', `${String(i).padStart(3, '0')}.png`) })
    await page.waitForTimeout(40)
  }
  await page.keyboard.press(' ')
  for (const [key, name] of [
    ['1', 'pact'],
    ['2', 'legion'],
    ['4', 'unit'],
    ['5', 'ghost'],
  ] as const) {
    await page.keyboard.press(key)
    await page.waitForTimeout(400)
    await expect(page.getByTestId('engine-status')).toHaveAttribute('data-state', 'ready', { timeout: 60_000 })
    await expect(cartridge).toHaveAttribute('data-state', 'preview', { timeout: 90_000 })
    await page.waitForTimeout(900)
    await page.keyboard.press(' ')
    await page.waitForTimeout(1_600)
    await core.screenshot({ path: join(OUT!, `_core-${name}.png`) })
    await page.keyboard.press(' ')
  }

  // 02: the rack.
  await page.keyboard.press('1')
  await expect(cartridge).toHaveAttribute('data-state', 'preview', { timeout: 90_000 })
  await page.getByRole('button', { name: 'Open rack' }).click()
  await page.waitForTimeout(1_000)
  await page.mouse.move(2, 2)
  await shot('02-rack-open.png')
  await page.getByRole('button', { name: 'Close rack' }).click()
  await page.waitForTimeout(600)

  // 04: RECORD.
  await page.getByRole('tab', { name: 'RECORD' }).click()
  await page.waitForTimeout(800)
  await page.mouse.move(2, 2)
  await shot('04-record.png')
  await page.getByRole('tab', { name: 'TYPE' }).click()

  // 07: VOICES with the MODELS strip.
  await nav(page, 'VOICES')
  await expect(page.getByRole('heading', { name: 'Models' })).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(1_200)
  await page.mouse.move(2, 2)
  await shot('07-voices-models.png')
})
