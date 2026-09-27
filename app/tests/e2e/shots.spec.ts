import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { launchApp, waitReady, waitWipe, type Launched } from './app'

// Design screenshots against the real engine, at the handoff's two frame sizes. Opt-in:
//   FVWKS_SHOTS=docs/screens/after npx playwright test shots
const OUT = process.env.FVWKS_SHOTS ? resolve(process.env.FVWKS_SHOTS) : null
const SIZES = [
  [1512, 982],
  [1280, 800],
] as const

let run: Launched

test.skip(!OUT, 'set FVWKS_SHOTS=<dir> to capture the design screenshots')
test.setTimeout(420_000)

test.afterEach(async () => {
  await run?.app.close()
})

test('design screenshots', async () => {
  run = await launchApp()
  const { app, page } = run
  const setSize = (w: number, h: number) =>
    app.evaluate(({ BrowserWindow }, [cw, ch]) => BrowserWindow.getAllWindows()[0]?.setContentSize(cw!, ch!), [w, h])
  const shot = async (name: string, sizes: readonly (readonly [number, number])[] = SIZES) => {
    for (const [w, h] of sizes) {
      await setSize(w, h)
      await page.waitForTimeout(350)
      const dir = join(OUT!, `${w}x${h}`)
      mkdirSync(dir, { recursive: true })
      await page.screenshot({ path: join(dir, `${name}.png`) })
    }
  }
  const nav = async (screen: string) => {
    await page.getByRole('navigation').getByRole('button', { name: screen }).click()
    await waitWipe(page)
    await page.waitForTimeout(250)
  }

  // Boot, mid-sequence (the engine is still starting), at the default size only.
  await page.waitForTimeout(1_200)
  await shot('00-boot', [SIZES[0]])
  await waitReady(page)
  await page.waitForTimeout(1_200) // panel reveal
  await shot('01-studio-empty')

  const editor = page.getByTestId('script-editor')
  await editor.fill('WE ARE GUY FVWKS | EXPECT *US*')
  const cartridge = page.getByTestId('cartridge')
  await expect(cartridge).toHaveAttribute('data-state', 'preview', { timeout: 60_000 })
  await page.waitForTimeout(900) // reveal sweep
  await editor.blur()
  await shot('02-studio-preview')

  await page.keyboard.press(' ')
  await page.waitForTimeout(900)
  await shot('03-studio-playing', [SIZES[0]])
  await page.keyboard.press(' ')

  await page.getByRole('button', { name: 'Open rack' }).click()
  await page.waitForTimeout(900)
  await shot('04-rack-open')
  await page.getByRole('button', { name: 'Close rack' }).click()
  await expect(page.getByRole('region', { name: 'Rack modules' })).toHaveCount(0)

  await page.keyboard.press('Meta+Enter')
  await expect(cartridge).toHaveAttribute('data-state', 'ready', { timeout: 60_000 })
  await page.waitForTimeout(1_400)
  await shot('05-studio-final')

  await page.getByRole('tab', { name: 'RECORD' }).click()
  await page.waitForTimeout(500)
  await shot('06-record')
  await page.getByRole('tab', { name: 'TYPE' }).click()

  await page.getByRole('button', { name: '+ SETLIST' }).click()

  // FIT overflow: a long line on one bar.
  await editor.fill('WE ARE GUY FVWKS | WE DO NOT FORGIVE [0.5] WE DO NOT FORGET | EXPECT *US*')
  await page.getByRole('radiogroup', { name: 'Bars' }).getByRole('radio', { name: '1', exact: true }).click()
  await expect(page.getByRole('status', { name: 'Fit' })).toContainText(/EXTENDED|OVERFLOW|STRETCHED/, { timeout: 60_000 })
  await page.waitForTimeout(900)
  await editor.blur()
  await shot('07-fit-overflow')

  await nav('VAULT')
  await shot('08-vault')
  await nav('SETLIST')
  await shot('09-setlist')
  await nav('VOICES')
  await shot('10-voices')
  await nav('SETTINGS')
  await shot('11-settings')

  await page.keyboard.press('?')
  await shot('12-shortcuts', [SIZES[0]])
  await page.keyboard.press('Escape')

  // Engine offline: kill the engine and catch the banner while it restarts.
  await nav('STUDIO')
  const { pid } = await page.evaluate(() => window.fvwks!.getEngineStatus())
  process.kill(pid!, 'SIGKILL')
  await expect(page.getByRole('alert').filter({ hasText: /ENGINE (OFFLINE|RESTARTING)/ })).toBeVisible({ timeout: 10_000 })
  await shot('14-engine-restarting', [SIZES[0]])
  await waitReadyAgain(page)
})

async function waitReadyAgain(page: Page) {
  await expect(page.getByTestId('engine-status')).toHaveAttribute('data-state', 'ready', { timeout: 60_000 })
}
