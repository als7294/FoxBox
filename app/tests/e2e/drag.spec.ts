import { expect, test } from '@playwright/test'
import { launchApp, waitReady, type Launched } from './app'

// Covers the drag chain up to the OS: dragstart → preload → IPC → main's export guard →
// webContents.startDrag({file, icon}). The drop itself (Finder, GarageBand, Rekordbox) is a manual check.
let run: Launched

test.afterEach(async () => {
  await run?.app.close()
})

interface DragRecord {
  file: string
  files: string[] | null
  iconEmpty: boolean
  iconWidth: number
}

test('dragging the cartridge starts a native file drag with the exported file and a real icon', async () => {
  run = await launchApp()
  const { app, page, dirs } = run
  await waitReady(page)

  // Record startDrag calls in main instead of starting an OS drag session.
  await app.evaluate(({ webContents }) => {
    const g = globalThis as unknown as { __drags: unknown[] }
    g.__drags = []
    for (const wc of webContents.getAllWebContents()) {
      wc.startDrag = (item) => {
        g.__drags.push({
          file: item.file,
          files: item.files ?? null,
          iconEmpty: typeof item.icon === 'string' ? false : item.icon.isEmpty(),
          iconWidth: typeof item.icon === 'string' ? 0 : item.icon.getSize().width,
        })
      }
    }
  })
  const drags = () => app.evaluate(() => (globalThis as unknown as { __drags: DragRecord[] }).__drags)

  await page.getByTestId('script-editor').fill('WE ARE GUY FVWKS | EXPECT *US*')
  await page.getByTestId('script-editor').press('Meta+Enter')
  const cartridge = page.getByTestId('cartridge')
  await expect(cartridge).toHaveAttribute('data-state', 'ready', { timeout: 60_000 })
  const filename = (await page.getByTestId('cartridge-filename').textContent())!.trim()

  await cartridge.locator('[draggable="true"]').dispatchEvent('dragstart')
  await expect.poll(async () => (await drags()).length).toBe(1)
  const [drag] = await drags()
  expect(drag!.file.endsWith(`/${filename}`)).toBe(true)
  expect(drag!.file.startsWith(dirs.exports) || drag!.file.includes('fvwks-e2e-')).toBe(true)
  expect(drag!.iconEmpty).toBe(false)
  expect(drag!.iconWidth).toBeGreaterThan(0)

  // Paths the engine never returned are refused, even from a compromised renderer.
  await page.evaluate(() => {
    window.fvwks!.startDrag('/etc/hosts')
    window.fvwks!.startDrag(['/etc/hosts', '/etc/passwd'])
  })
  await page.waitForTimeout(300)
  expect(await drags()).toHaveLength(1)
  expect(await page.evaluate(() => window.fvwks!.reveal('/etc/hosts'))).toBe(false)
})
