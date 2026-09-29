// Renders banner.html to ../foxbox-banner.png (2560×1280: the README banner and GitHub's social preview).
// From app/: node design/brand/banner/render.mjs   (uses the e2e tests' Playwright Chromium)
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'

const here = dirname(fileURLToPath(import.meta.url))
const out = process.argv[2] ?? join(here, '..', 'foxbox-banner.png')
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 2560, height: 1280 }, deviceScaleFactor: 1 })
await page.goto(pathToFileURL(join(here, 'banner.html')).href)
await page.evaluate(() => document.fonts.ready)
await page.waitForTimeout(300)
await page.screenshot({ path: out })
await browser.close()
console.log(`wrote ${out}`)
