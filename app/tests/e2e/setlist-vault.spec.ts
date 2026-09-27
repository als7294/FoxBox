import { expect, test } from '@playwright/test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, waitReady, type Launched } from './app'

let run: Launched

test.afterEach(async () => {
  await run?.app.close()
})

test('a 5-line setlist batch produces 5 files plus a playlist XML; the vault lists and exports them', async () => {
  run = await launchApp()
  const { page, dirs } = run
  await waitReady(page)

  await page.getByRole('navigation').getByRole('button', { name: 'SETLIST' }).click()
  await expect(page.getByRole('heading', { level: 1, name: 'SETLIST' })).toBeVisible()
  // The paste panel starts open on an empty setlist; + PASTE MANY toggles it.
  const pasteToggle = page.getByRole('button', { name: '+ PASTE MANY' })
  if ((await pasteToggle.getAttribute('aria-expanded')) !== 'true') await pasteToggle.click()
  await page.getByLabel('Paste lines', { exact: true }).fill(
    ['WE ARE GUY FVWKS | EXPECT *US*', 'REMEMBER REMEMBER', 'PUT YOUR HANDS UP', 'WE DO NOT FORGIVE [2b] WE DO NOT FORGET', 'THE SIGNAL NEVER DIES'].join('\n'),
  )
  await page.getByRole('button', { name: 'ADD LINES' }).click()
  await expect(page.getByRole('table', { name: 'Setlist' }).getByRole('row')).toHaveCount(6) // header + 5
  await page.getByLabel('PLAYLIST NAME').fill('E2E Drops')
  const renderAll = page.getByTestId('render-all')
  await expect(renderAll).toHaveText('RENDER ALL')
  await renderAll.click()
  await expect(page.getByTestId('setlist-summary')).toHaveText('5 LINES · 5 DONE', { timeout: 120_000 })
  // The batch has settled (the XML is written after the last line) once the button is back.
  await expect(renderAll).toHaveText('RENDER ALL', { timeout: 30_000 })

  // The engine writes a batch into its own folder under the export root.
  const files = (readdirSync(dirs.exports, { recursive: true }) as string[]).map((f) => join(dirs.exports, f))
  expect(files.filter((f) => /\.(aiff|wav)$/.test(f))).toHaveLength(5)
  const xml = files.find((f) => f.endsWith('_rekordbox.xml'))
  expect(xml).toBeTruthy()
  expect(readFileSync(xml!, 'utf8')).toContain('E2E Drops')

  // VAULT: five takes, playable, and the selection exports to a Rekordbox playlist.
  await page.getByRole('navigation').getByRole('button', { name: 'VAULT' }).click()
  const vault = page.getByRole('table', { name: 'Vault' })
  await expect(vault.getByRole('row')).toHaveCount(6) // header + 5
  await vault.getByRole('button', { name: /^Play / }).first().click()
  await expect(vault.getByRole('button', { name: /^Stop / })).toBeVisible()
  await vault.getByLabel('Select all').check()
  await expect(page.getByRole('group', { name: 'Selected takes' })).toContainText('5 SELECTED')
  await page.getByRole('button', { name: 'EXPORT TO REKORDBOX PLAYLIST' }).click()
  const written = page.getByRole('dialog', { name: 'REKORDBOX XML EXPORTED' })
  await expect(written).toBeVisible({ timeout: 30_000 })
  await expect(written).toContainText(/_rekordbox\.xml/)
  await expect(written).toContainText('5 tracks')
  await written.getByRole('button', { name: 'DONE' }).click()
  expect(existsSync(xml!)).toBe(true)
})
