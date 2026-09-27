import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

export const APP_DIR = resolve(__dirname, '../..')

export interface Launched {
  app: ElectronApplication
  page: Page
  dirs: { root: string; data: string; exports: string; userData: string }
}

/** Launches the built app (out/) with isolated data, export and profile folders. */
export async function launchApp(env: Record<string, string> = {}, extraArgs: string[] = []): Promise<Launched> {
  const root = mkdtempSync(join(tmpdir(), 'fvwks-e2e-'))
  const dirs = { root, data: join(root, 'data'), exports: join(root, 'exports'), userData: join(root, 'electron') }
  mkdirSync(dirs.exports, { recursive: true })
  const app = await electron.launch({
    args: [APP_DIR, ...extraArgs],
    cwd: APP_DIR,
    env: {
      ...process.env,
      FVWKS_USER_DATA_DIR: dirs.userData,
      FVWKS_DATA_DIR: dirs.data,
      FVWKS_EXPORT_DIR: dirs.exports,
      ...env,
    } as Record<string, string>,
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page, dirs }
}

/** The engine is READY and the boot sequence has handed over (the boot overlay is gone). */
export async function waitReady(page: Page, timeout = 120_000): Promise<void> {
  await expect(page.getByTestId('engine-status')).toHaveAttribute('data-state', 'ready', { timeout })
  await expect(page.getByTestId('boot')).toHaveCount(0, { timeout: 20_000 })
}

/** Waits for the screen-change wipe to finish (screenshots, clicks on the new screen). */
export async function waitWipe(page: Page): Promise<void> {
  await expect(page.locator('[data-wipe]')).toHaveCount(0)
}
