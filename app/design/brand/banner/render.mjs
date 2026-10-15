// Renders banner.html to ../foxbox-banner.png (2560×1280: the README banner and GitHub's social preview).
// From app/: node design/brand/banner/render.mjs [out.png] [page.html]   (uses the e2e tests' Playwright Chromium)
// The page defaults to banner-2.0.html (FoxBox 2.0); banner.html is the 1.x banner.
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'

const here = dirname(fileURLToPath(import.meta.url))
const out = process.argv[2] ?? join(here, '..', 'foxbox-banner.png')
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 2560, height: 1280 }, deviceScaleFactor: 1 })
await page.goto(pathToFileURL(join(here, process.argv[3] ?? 'banner-2.0.html')).href)
await page.evaluate(() => document.fonts.ready)
await page.waitForTimeout(300)
await page.screenshot({ path: out })
await browser.close()
console.log(`wrote ${out}`)
